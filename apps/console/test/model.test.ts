import { describe, expect, it } from 'vitest';
import {
  DATA_STATUSES,
  PROTOCOL_STATUSES,
  type DataStatus,
  type DeploymentStatus,
  type ProtocolStatus,
} from '../src/api/contract.js';
import { dataBadge, isHealthyTone, protocolBadge, statusView } from '../src/model/verdict.js';
import {
  ASSET_MODES,
  CLAIM_MODES,
  COVERAGE_CAVEAT,
  FORBIDDEN_CLAIMS,
  ForbiddenClaimError,
  NATIVE_PANEL_CAVEAT,
  assertBoundedLanguage,
  claimCopy,
  coverageCopy,
  COVERAGE_STATES,
} from '../src/model/claim.js';
import {
  formatAge,
  formatAmount,
  formatBaseUnits,
  formatInstant,
  shortDigest,
  DIGIT_SEPARATOR,
} from '../src/model/format.js';
import {
  CONDITIONS,
  conditionCopy,
  deriveCondition,
  isHealthyCondition,
  loading,
  SLOW_AFTER_MS,
} from '../src/model/screen.js';
import {
  DEPLOYMENT_TABS,
  deploymentRoute,
  documentTitle,
  parseRoute,
  routeHash,
} from '../src/model/route.js';
import { deriveIncidents } from '../src/model/incidents.js';
import { PastedSecretError, reviewDiscovery } from '../src/model/onboarding.js';

const status = (overrides: Partial<DeploymentStatus> = {}): DeploymentStatus => ({
  deploymentId: 'acme-usdc',
  evidenceDigest: 'a'.repeat(64),
  sharingLevel: 'approved-full',
  verifyStatus: 'verified',
  protocolStatus: 'OK',
  dataStatus: 'COMPLETE',
  observedAt: '2026-06-01T00:00:00.000Z',
  expiresAt: '2026-06-01T01:00:00.000Z',
  receivedAt: '2026-06-01T00:00:01.000Z',
  stale: false,
  currentProtocolStatus: 'OK',
  currentDataStatus: 'COMPLETE',
  ...overrides,
});

describe('verdict presentation', () => {
  it('never paints anything but a reconciled protocol status as healthy', () => {
    for (const s of PROTOCOL_STATUSES) {
      const badge = protocolBadge(s);
      expect(isHealthyTone(badge.tone)).toBe(s === 'OK');
    }
    for (const s of DATA_STATUSES) {
      const badge = dataBadge(s);
      expect(isHealthyTone(badge.tone)).toBe(s === 'COMPLETE');
    }
  });

  it('separates a proven breach from a blind spot in tone, glyph and wording', () => {
    const critical = protocolBadge('CRITICAL');
    const unknown = protocolBadge('UNKNOWN');
    expect(critical.tone).not.toBe(unknown.tone);
    expect(critical.glyph).not.toBe(unknown.glyph);
    expect(critical.label).not.toBe(unknown.label);
    expect(critical.meaning).not.toBe(unknown.meaning);
    // Every badge carries meaning without its colour: a glyph and a label.
    for (const s of PROTOCOL_STATUSES) {
      expect(protocolBadge(s).glyph.length).toBeGreaterThan(0);
      expect(protocolBadge(s).label.length).toBeGreaterThan(0);
    }
  });

  it('renders the degraded fields the server computed, never the raw ones', () => {
    const view = statusView(
      status({
        protocolStatus: 'OK',
        stale: true,
        currentProtocolStatus: 'UNKNOWN',
        currentDataStatus: 'STALE',
      }),
    );
    expect(view.protocol.tone).toBe('unknown');
    expect(isHealthyTone(view.protocol.tone)).toBe(false);
    expect(view.staleNotice).toContain('not a current health claim');
  });
});

describe('screen conditions', () => {
  it('is green only when everything is fresh, complete and reconciled', () => {
    expect(deriveCondition({ status: status() })).toBe('healthy-fresh');
    for (const condition of CONDITIONS) {
      expect(isHealthyCondition(condition)).toBe(condition === 'healthy-fresh');
      expect(isHealthyTone(conditionCopy(condition).tone)).toBe(condition === 'healthy-fresh');
    }
  });

  it('applies fail-closed precedence across every contract combination', () => {
    expect(deriveCondition({ status: status({ currentProtocolStatus: 'CRITICAL' }) })).toBe(
      'critical',
    );
    // A data fault outranks an inability to interpret, and both outrank staleness.
    expect(
      deriveCondition({
        status: status({ currentDataStatus: 'DIVERGENT' }),
        claimMode: 'UNSUPPORTED',
      }),
    ).toBe('split-brain');
    expect(deriveCondition({ status: status({ stale: true }), claimMode: 'UNSUPPORTED' })).toBe(
      'unsupported-adapter',
    );
    expect(deriveCondition({ status: status({ stale: true }) })).toBe('stale');
    expect(deriveCondition({ status: status(), censusComplete: false })).toBe('incomplete-census');
    expect(deriveCondition({ status: status({ currentProtocolStatus: 'WARN' }) })).toBe('warn');

    // Nothing in the whole contract space is allowed to reach green unless it is
    // genuinely OK and COMPLETE.
    for (const p of PROTOCOL_STATUSES) {
      for (const d of DATA_STATUSES) {
        for (const stale of [true, false]) {
          const condition = deriveCondition({
            status: status({ currentProtocolStatus: p, currentDataStatus: d, stale }),
          });
          const green = isHealthyCondition(condition);
          expect(green).toBe(p === 'OK' && d === 'COMPLETE' && !stale);
        }
      }
    }
  });

  it('gives a slow load a reason and a remedy instead of an endless spinner', () => {
    expect(loading(0).slow).toBe(false);
    const slow = loading(SLOW_AFTER_MS + 1);
    expect(slow.slow).toBe(true);
    expect(slow.remedy).toContain('Local evaluation, evidence and alerting continue');
  });
});

describe('claim language', () => {
  it('keeps the native and canonical vocabularies apart', () => {
    const nativeBound = claimCopy('native', 'SUFFICIENT_UPPER_BOUND');
    expect(nativeBound.headline).toContain('upper bound');
    expect(nativeBound.notClaimed).toContain('not a supply figure');

    // The canonical vocabulary refuses upper-bound language outright.
    expect(claimCopy('canonical-erc20', 'SUFFICIENT_UPPER_BOUND').headline).toContain(
      'Not applicable',
    );
    // And native mode never offers an exact-equality claim.
    expect(claimCopy('native', 'EXACT').headline).toContain('Not available');
    expect(claimCopy('native', 'CAUSAL_EXACT').headline).toContain('Not available');
  });

  it('emits no forbidden claim for any asset mode and claim combination', () => {
    for (const mode of ASSET_MODES) {
      for (const claim of CLAIM_MODES) {
        const copy = claimCopy(mode, claim);
        expect(() =>
          assertBoundedLanguage(`${copy.headline} ${copy.detail} ${copy.notClaimed}`),
        ).not.toThrow();
      }
    }
    for (const state of COVERAGE_STATES) {
      expect(() => assertBoundedLanguage(coverageCopy(state))).not.toThrow();
    }
    expect(() => assertBoundedLanguage(COVERAGE_CAVEAT)).not.toThrow();
    expect(() => assertBoundedLanguage(NATIVE_PANEL_CAVEAT)).not.toThrow();
  });

  it('refuses every claim the product may not make', () => {
    const samples = [
      'this deployment is solvent',
      'a proof of reserves for the bridge',
      'coverage is guaranteed',
      'the evidence is tamper-proof',
      'the remote is fully backed',
      'we report the exact total supply',
    ];
    for (const sample of samples) {
      expect(() => assertBoundedLanguage(sample)).toThrow(ForbiddenClaimError);
    }
    expect(FORBIDDEN_CLAIMS.length).toBeGreaterThan(5);
  });
});

describe('unit-safe formatting', () => {
  it('renders base units beyond 2^53 without losing a digit', () => {
    const huge = '123456789012345678901234567890';
    // A plain ASCII space, so a grouped figure survives copy and paste. An
    // invisible typographic separator once slipped in here; this pins it.
    expect(DIGIT_SEPARATOR).toBe('\u0020');
    expect(formatBaseUnits(huge).split(DIGIT_SEPARATOR).join('')).toBe(huge);
    // The same value through a double would have lost its tail entirely.
    expect(String(Number(huge))).not.toBe(huge);
  });

  it('scales by decimals with string arithmetic and never rounds up', () => {
    expect(formatAmount('1000000', 6)).toBe('1');
    expect(formatAmount('1234567', 6)).toBe('1.234567');
    expect(formatAmount('1234567891', 6)).toBe('1 234.567891');
    // Truncated, never rounded, and the truncation is visible.
    expect(formatAmount('1999999999999999999', 18, 2)).toBe('1.99…');
    expect(formatAmount(2n ** 200n, 0)).toContain('1 606 938');
  });

  it('rejects anything that is not a canonical base-unit integer', () => {
    expect(() => formatBaseUnits('1.5')).toThrow();
    expect(() => formatBaseUnits('1e18')).toThrow();
    expect(() => formatAmount('12', 1e3)).toThrow();
  });

  it('renders instants in UTC and ages relative to an injected clock', () => {
    expect(formatInstant('2026-06-01T12:34:56.000Z')).toBe('2026-06-01 12:34:56 UTC');
    const now = Date.parse('2026-06-01T12:00:00.000Z');
    expect(formatAge('2026-06-01T11:00:00.000Z', now)).toBe('1h ago');
    expect(formatAge('2026-06-01T12:00:30.000Z', now)).toBe('timestamped in the future');
    expect(shortDigest('a'.repeat(64))).toBe(`${'a'.repeat(8)}…${'a'.repeat(8)}`);
  });
});

describe('routing', () => {
  it('round-trips every route', () => {
    const routes = [
      { page: 'deployments' },
      { page: 'onboarding' },
      { page: 'overview', deploymentId: 'acme-usdc' },
      { page: 'coverage', deploymentId: 'acme-usdc' },
      { page: 'messages', deploymentId: 'acme-usdc' },
      { page: 'incidents', deploymentId: 'acme-usdc' },
      { page: 'evidence', deploymentId: 'acme-usdc' },
      { page: 'evidence-detail', deploymentId: 'acme-usdc', digest: 'b'.repeat(64) },
    ] as const;
    for (const route of routes) {
      expect(parseRoute(routeHash(route))).toEqual(route);
    }
    for (const tab of DEPLOYMENT_TABS) {
      expect(parseRoute(routeHash(deploymentRoute(tab.page, 'acme-usdc'))).page).toBe(tab.page);
    }
  });

  it('refuses traversal, malformed escapes and unknown shapes', () => {
    const hostile = [
      '#/d/../../etc/passwd',
      '#/d/%2e%2e/status',
      '#/d/acme/evidence/notadigest',
      '#/d/ACME',
      '#/d/acme/unknown-tab',
      '#/%E0%A4%A',
      '#not-a-path',
    ];
    for (const hash of hostile) {
      expect(parseRoute(hash).page).toBe('not-found');
    }
    expect(documentTitle({ page: 'deployments' })).toContain('ictt-sentinel');
  });
});

describe('incident derivation', () => {
  const record = (observedAt: string, protocolStatus: ProtocolStatus, digest: string) => ({
    deploymentId: 'acme-usdc',
    evidenceDigest: digest.repeat(64).slice(0, 64),
    sharingLevel: 'approved-full' as const,
    verifyStatus: 'verified' as const,
    protocolStatus,
    dataStatus: 'COMPLETE' as DataStatus,
    observedAt,
    expiresAt: observedAt,
    receivedAt: observedAt,
  });

  it('folds a run of non-OK evaluations into one incident and closes it on recovery', () => {
    // Newest first, as the API returns it.
    const timeline = [
      record('2026-06-01T05:00:00.000Z', 'OK', '5'),
      record('2026-06-01T04:00:00.000Z', 'CRITICAL', '4'),
      record('2026-06-01T03:00:00.000Z', 'WARN', '3'),
      record('2026-06-01T02:00:00.000Z', 'WARN', '2'),
      record('2026-06-01T01:00:00.000Z', 'OK', '1'),
    ];
    const incidents = deriveIncidents(timeline);
    expect(incidents).toHaveLength(1);
    const incident = incidents[0]!;
    expect(incident.firstSeen).toBe('2026-06-01T02:00:00.000Z');
    expect(incident.occurrences).toBe(3);
    // Peak is the worst reached, not the latest seen.
    expect(incident.peak).toBe('CRITICAL');
    expect(incident.recovered).toBe(true);
    expect(incident.recoveredAt).toBe('2026-06-01T05:00:00.000Z');
    expect(incident.evidenceDigests).toHaveLength(3);
  });

  it('leaves an unrecovered run open', () => {
    const incidents = deriveIncidents([
      record('2026-06-01T02:00:00.000Z', 'UNKNOWN', '2'),
      record('2026-06-01T01:00:00.000Z', 'UNKNOWN', '1'),
    ]);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.recovered).toBe(false);
    expect(incidents[0]!.current).toBe('UNKNOWN');
  });

  it('reports nothing for an entirely healthy timeline', () => {
    expect(deriveIncidents([record('2026-06-01T01:00:00.000Z', 'OK', '1')])).toHaveLength(0);
  });
});

describe('onboarding review', () => {
  const draft = {
    metadata: { name: 'acme-usdc' },
    spec: {
      asset: { mode: 'canonical-erc20' },
      home: {
        name: 'home',
        chain: {
          blockchainId: `0x${'1'.repeat(64)}`,
          endpoints: [
            {
              id: 'a',
              trustDomain: 'alpha',
              providerGroup: 'alpha-1',
              role: 'primary',
              archiveDepth: 'full',
              secretRef: 'ICTT_SENTINEL_HOME_A',
            },
            {
              id: 'b',
              trustDomain: 'alpha',
              providerGroup: 'alpha-1',
              role: 'secondary',
              archiveDepth: 'pruned',
              secretRef: 'ICTT_SENTINEL_HOME_B',
            },
          ],
        },
      },
      remotes: [
        {
          name: 'remote',
          chain: { blockchainId: `0x${'2'.repeat(64)}`, endpoints: [] },
          tokenRemote: { address: `0x${'3'.repeat(40)}` },
        },
      ],
    },
  };

  it('summarises variable names and flags endpoints that are one witness', () => {
    const review = reviewDiscovery(JSON.stringify(draft));
    expect(review.deploymentName).toBe('acme-usdc');
    expect(review.requiredSecretRefs).toEqual(['ICTT_SENTINEL_HOME_A', 'ICTT_SENTINEL_HOME_B']);
    const home = review.chains[0]!;
    expect(home.distinctProviderGroups).toBe(1);
    expect(home.sharedProviderGroups).toEqual(['alpha-1']);
    expect(review.candidateRemotes).toHaveLength(1);
  });

  it('refuses a pasted document that carries a value instead of a name', () => {
    const leaked = structuredClone(draft) as typeof draft & Record<string, unknown>;
    (leaked.spec.home.chain.endpoints[0] as Record<string, unknown>)['secretRef'] =
      'https://rpc.example.com/v1/0123456789abcdef';
    let thrown: unknown = null;
    try {
      reviewDiscovery(JSON.stringify(leaked));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(PastedSecretError);
    const error = thrown as PastedSecretError;
    expect(error.issues[0]?.path).toContain('endpoints[0].secretRef');
    // The refusal names the path and never echoes the value it refused.
    expect(error.message).not.toContain('rpc.example.com');
    expect(JSON.stringify(error.issues)).not.toContain('rpc.example.com');
  });

  it('rejects input that is not the discovery draft at all', () => {
    expect(() => reviewDiscovery('not json')).toThrow(SyntaxError);
  });
});
