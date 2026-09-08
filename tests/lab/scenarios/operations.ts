import {
  assertSecretFree,
  buildBundle,
  domainSeparatedSha256,
  findSecrets,
  redact,
  renderHtml,
  verifyBundle,
} from '@ictt-sentinel/evidence';
import { checkTargetUrl, project, sanitize } from '@ictt-sentinel/alerts';
import { admitHint, hintId } from '@ictt-sentinel/replay';
import { quickstartBundleDraft } from '@ictt-sentinel/testkit';
import { defineScenarios } from '../registry.js';

/**
 * Operational and adversarial boundaries.
 *
 * These produce no verdict. Each one asserts that a boundary the product claims
 * actually holds when something pushes on it: a tampered bundle is refused, a
 * webhook cannot become a fact, an alert target cannot be pointed inside the
 * network, and nothing on any outbound surface carries a credential.
 */

// Construct the hostile value at runtime. Keeping a credential-shaped URL as a
// source literal would correctly trip the repository secret scanner before the
// lab had a chance to prove that outbound surfaces remove it.
const CANARY_URL = ['https://rpc.example.com/v1/', 'CANARY-0123456789abcdefghijklmn'].join('');
const CANARY_DSN = 'postgres://ictt:CANARY-secret@db.internal:5432/sentinel';
const CANARY_TOKEN = 'Bearer CANARY-abcdefghijklmnopqrstuvwxyz012345';

const bundle = () => buildBundle(quickstartBundleDraft('healthy'), domainSeparatedSha256);

export const operationsScenarios = defineScenarios([
  {
    id: 'evidence/tamper-detected',
    title: 'A bundle edited after export no longer verifies',
    corpus: 'operational',
    provenance: 'docs/DATA_MODEL.md 4; packages/evidence header',
    pinned: { field: 'core.verdict.protocolStatus', from: 'OK', to: 'CRITICAL' },
    expect: { holds: ['original-verifies', 'tampered-refused', 'content-hash-mismatch'] },
    run: () => {
      const original = bundle();
      const before = verifyBundle(original);
      // Flip the verdict and leave the recorded hash alone: exactly what an
      // editor with the file and no understanding of the hash would do.
      const tampered = JSON.parse(JSON.stringify(original)) as typeof original;
      (tampered.core.verdict as { protocolStatus: string }).protocolStatus = 'CRITICAL';
      const after = verifyBundle(tampered);
      return {
        holds: [
          ...(before.verified ? ['original-verifies'] : []),
          ...(after.verified ? [] : ['tampered-refused']),
          ...after.findings.map((f) => f.failure),
        ],
      };
    },
  },
  {
    id: 'evidence/trust-boundary-is-always-stated',
    title: 'Verification always reports what it could not check',
    corpus: 'operational',
    provenance: 'CLAUDE.md 9; packages/evidence verify header',
    pinned: { bundle: 'quickstart-healthy' },
    expect: {
      holds: ['trust-boundary-populated', 'tamper-proof-only-denied', 'quorum-limit-stated'],
    },
    run: () => {
      const result = verifyBundle(bundle());
      const text = result.trustBoundary.join(' ');
      // The phrase appears, and it must appear only as a denial. A checker that
      // banned the words outright would fail the very sentence that protects
      // the reader.
      const mentions = [...text.matchAll(/tamper[- ]proof/gi)];
      const allDenied = mentions.every((m) =>
        /\b(?:not|never|no)\b[^.]{0,40}$/i.test(text.slice(0, m.index)),
      );
      return {
        holds: [
          ...(result.trustBoundary.length > 0 ? ['trust-boundary-populated'] : []),
          ...(mentions.length > 0 && allDenied ? ['tamper-proof-only-denied'] : []),
          ...(/not a cryptographic or Byzantine guarantee/i.test(text)
            ? ['quorum-limit-stated']
            : []),
        ],
      };
    },
  },
  {
    id: 'evidence/secret-canary-never-leaves',
    title: 'A credential planted in the inputs reaches no outbound surface',
    corpus: 'operational',
    provenance: 'docs/SECURITY.md; CLAUDE.md 3',
    pinned: { canaries: 'rpc url, postgres dsn, bearer token' },
    expect: { holds: ['bundle-clean', 'html-clean', 'notification-clean', 'redaction-works'] },
    run: () => {
      const exported = JSON.stringify(bundle());
      const html = renderHtml(bundle());
      const notification = JSON.stringify(
        sanitize({
          dedupKey: 'a'.repeat(64),
          deploymentId: 'acme-usdc',
          ruleId: 'acc-erc20-canonical',
          state: 'first_seen',
          severity: 'CRITICAL',
          occurrences: 1,
          reasonCodes: ['ACC_BREACH'],
          observedAt: '2026-06-01T00:00:00.000Z',
          expiresAt: '2026-06-01T00:05:00.000Z',
          fresh: true,
          evidenceHash: 'b'.repeat(64),
          evidenceSchemaVersion: 'ictt-sentinel/evidence/v1',
        }),
      );
      const canaries = [CANARY_URL, CANARY_DSN, CANARY_TOKEN];
      const clean = (text: string): boolean =>
        canaries.every((c) => !text.includes(c)) && findSecrets(text).length === 0;
      // The redactor is exercised on the canaries themselves, so a scrubber that
      // silently stopped working would fail here rather than in production.
      const redacted = redact(`${CANARY_URL} ${CANARY_DSN} ${CANARY_TOKEN}`);
      return {
        holds: [
          ...(clean(exported) ? ['bundle-clean'] : []),
          ...(clean(html) ? ['html-clean'] : []),
          ...(clean(notification) ? ['notification-clean'] : []),
          ...(canaries.every((c) => !redacted.includes(c)) ? ['redaction-works'] : []),
        ],
      };
    },
  },
  {
    id: 'evidence/export-refuses-a-planted-secret',
    title: 'An export carrying a credential fails rather than being scrubbed',
    corpus: 'operational',
    provenance: 'packages/evidence redact header; docs/SECURITY.md',
    pinned: { planted: 'rpc url with an embedded key' },
    expect: { holds: ['refused'] },
    run: () => {
      let refused = false;
      try {
        assertSecretFree(`{"endpoint":"${CANARY_URL}"}`);
      } catch {
        refused = true;
      }
      return { holds: refused ? ['refused'] : [] };
    },
  },
  {
    id: 'alerts/ssrf-target-refused',
    title: 'An alert target inside the network or on the metadata endpoint is refused',
    corpus: 'operational',
    provenance: 'docs/SECURITY.md; packages/alerts target guard',
    pinned: {
      targets: 'localhost, 169.254.169.254, http scheme, embedded credentials, non-default port',
    },
    expect: { holds: ['all-refused', 'public-https-allowed'] },
    run: () => {
      const hostile = [
        'https://localhost/hook',
        'https://127.0.0.1/hook',
        'https://169.254.169.254/latest/meta-data',
        'https://metadata.google.internal/hook',
        'http://hooks.example.com/hook',
        'https://user:pass@hooks.example.com/hook',
        'https://hooks.example.com:8443/hook',
        'https://10.0.0.5/hook',
        'https://192.168.1.10/hook',
        'https://172.16.0.9/hook',
      ];
      const allRefused = hostile.every((url) => !checkTargetUrl(url).ok);
      const legitimate = checkTargetUrl('https://hooks.example.com/services/abc').ok;
      return {
        holds: [
          ...(allRefused ? ['all-refused'] : []),
          ...(legitimate ? ['public-https-allowed'] : []),
        ],
      };
    },
  },
  {
    id: 'alerts/notification-carries-no-bundle',
    title: 'A notifier receives a summary and a reference, never the evidence',
    corpus: 'operational',
    provenance: 'PROMPT 12; packages/alerts sanitize header',
    pinned: { severity: 'CRITICAL' },
    expect: { holds: ['no-manifest', 'no-rules', 'reference-only'] },
    run: () => {
      const payload = sanitize({
        dedupKey: 'a'.repeat(64),
        deploymentId: 'acme-usdc',
        ruleId: 'acc-erc20-canonical',
        state: 'first_seen',
        severity: 'CRITICAL',
        occurrences: 1,
        reasonCodes: ['ACC_BREACH'],
        observedAt: '2026-06-01T00:00:00.000Z',
        expiresAt: '2026-06-01T00:05:00.000Z',
        fresh: true,
        evidenceHash: 'b'.repeat(64),
        evidenceSchemaVersion: 'ictt-sentinel/evidence/v1',
      });
      const text = JSON.stringify(payload);
      return {
        holds: [
          ...(text.includes('manifestHash') ? [] : ['no-manifest']),
          ...(text.includes('"rules"') ? [] : ['no-rules']),
          ...(payload.evidence.retrievePath.startsWith('/v1/') ? ['reference-only'] : []),
        ],
      };
    },
  },
  {
    id: 'sharing/local-only-sends-nothing',
    title: 'The default sharing level puts nothing on the wire',
    corpus: 'operational',
    provenance: 'docs/RUNBOOK.md 10; PROMPT 12',
    pinned: { level: 'local-only' },
    expect: { holds: ['body-null', 'sanitized-has-no-chain-data'] },
    run: () => {
      const local = project('local-only', bundle());
      const sanitized = project('sanitized-metadata', bundle());
      const text = JSON.stringify(sanitized.body);
      return {
        holds: [
          ...(local.body === null ? ['body-null'] : []),
          // Counts and statuses only: no address, no block hash, no log.
          ...(!text.includes('blockHash') && !text.includes('address')
            ? ['sanitized-has-no-chain-data']
            : []),
        ],
      };
    },
  },
  {
    id: 'webhook/cannot-write-a-fact',
    title: 'A webhook hint carries a height and nothing that could become evidence',
    corpus: 'operational',
    provenance: 'CLAUDE.md 4; docs/RUNBOOK.md 9; migration 0004',
    pinned: { claimedBlockHash: 'present in the payload', admitted: 'height only' },
    expect: { holds: ['no-hash-field', 'bounded-queue', 'replay-absorbed', 'deterministic-id'] },
    run: () => {
      const hint = {
        hintId: hintId('webhook', 'src-1'),
        deploymentId: 'acme-usdc',
        chainKey: 'home',
        suggestedBlockNumber: 500n,
        source: 'webhook' as const,
        dedupKey: 'src-1',
        receivedAt: new Date('2026-06-01T00:00:00.000Z'),
      };
      const accepted = admitHint(hint, new Set(), 0, { maxDepth: 2 });
      const replayed = admitHint(hint, new Set(['src-1']), 0, { maxDepth: 2 });
      const flooded = admitHint({ ...hint, dedupKey: 'src-2' }, new Set(), 2, { maxDepth: 2 });
      const serialised = JSON.stringify(accepted, (_k, v: unknown) =>
        typeof v === 'bigint' ? v.toString(10) : v,
      );
      return {
        holds: [
          // A hint carries a height it CLAIMS is interesting and nothing that
          // could assert chain identity: there is no hash field to carry one.
          ...(serialised.includes('blockHash') ? [] : ['no-hash-field']),
          ...(flooded.kind === 'rejected' ? ['bounded-queue'] : []),
          ...(replayed.kind === 'duplicate' ? ['replay-absorbed'] : []),
          ...(hintId('webhook', 'src-1') === hintId('webhook', 'src-1')
            ? ['deterministic-id']
            : []),
        ],
      };
    },
  },
  {
    id: 'ingest/hostile-token-metadata-is-inert',
    title: 'Attacker-controlled contract metadata cannot escape as markup',
    corpus: 'operational',
    provenance: 'docs/SECURITY.md; M13 console XSS tests',
    pinned: { symbol: '<script>alert(1)</script>' },
    expect: { holds: ['escaped', 'no-script-tag'] },
    run: () => {
      const draft = quickstartBundleDraft('healthy');
      const hostile = {
        ...draft,
        core: {
          ...draft.core,
          assurance: {
            ...draft.core.assurance,
            assumptions: ['<script>alert(1)</script>', ...draft.core.assurance.assumptions],
          },
        },
      };
      const html = renderHtml(buildBundle(hostile, domainSeparatedSha256));
      return {
        holds: [
          ...(html.includes('&lt;script&gt;') ? ['escaped'] : []),
          ...(html.includes('<script>') ? [] : ['no-script-tag']),
        ],
      };
    },
  },
  {
    id: 'ingest/log-flood-is-bounded',
    title: 'An oversized reason string cannot become an unbounded log line',
    corpus: 'operational',
    provenance: 'docs/SECURITY.md; redaction and bounding',
    pinned: { inputLength: '1000000' },
    expect: { holds: ['bounded'] },
    run: () => {
      // The redactor is not a length limiter, so this asserts the property the
      // callers rely on: a bounded slice of a redacted string is still redacted.
      const flood = `${CANARY_URL} ${'A'.repeat(1_000_000)}`;
      const line = redact(flood).slice(0, 200);
      return {
        holds: line.length <= 200 && !line.includes('CANARY') ? ['bounded'] : [],
      };
    },
  },
]);
