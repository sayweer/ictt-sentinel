import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { quickstartBundleDraft } from '@ictt-sentinel/testkit';
import {
  buildBundle,
  hashCore,
  verifyBundle,
  canonicalStringify,
  assertBundleShareable,
  decodeProofInput,
  renderHtml,
} from '../src/index.js';

describe('self-contained offline verification', () => {
  it('total-decodes arbitrary JSON without throwing or omitting its trust boundary', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (candidate) => {
        const result = verifyBundle(candidate);
        expect(typeof result.verified).toBe('boolean');
        expect(result.trustBoundary.length).toBeGreaterThan(0);
      }),
      { numRuns: 500, seed: 14 },
    );
  });
  it.each(['healthy', 'deficit'] as const)(
    'replays %s without fixture or caller inputs',
    (scenario) => {
      expect(
        verifyBundle(JSON.parse(JSON.stringify(buildBundle(quickstartBundleDraft(scenario)))))
          .verified,
      ).toBe(true);
    },
  );
  it.each([null, {}, [], { core: {} }, { core: { producer: {} } }])(
    'refuses malformed JSON safely',
    (value) => {
      expect(verifyBundle(value).verified).toBe(false);
    },
  );
  it.each(['rawFacts', 'chains', 'stateCalls', 'messages', 'rules', 'fingerprints'] as const)(
    'cannot remove %s and rehash to obtain PASS',
    (field) => {
      const b = buildBundle(quickstartBundleDraft('healthy'));
      const core = { ...b.core, [field]: [] };
      expect(verifyBundle({ ...b, core, contentHash: hashCore(core) }).verified).toBe(false);
    },
  );
  it('rejects altered intermediate arithmetic even after rehashing', () => {
    const b = buildBundle(quickstartBundleDraft('healthy'));
    const core = { ...b.core, rules: b.core.rules.map((r) => ({ ...r, dust: '999' })) };
    expect(
      verifyBundle({ ...b, core, contentHash: hashCore(core) }).findings.some(
        (f) => f.failure === 'verdict-mismatch',
      ),
    ).toBe(true);
  });
  it('compares reason codes as part of the verdict', () => {
    const b = buildBundle(quickstartBundleDraft('healthy'));
    const core = { ...b.core, verdict: { ...b.core.verdict, reasonCodes: [] } };
    expect(verifyBundle({ ...b, core, contentHash: hashCore(core) }).verified).toBe(false);
  });
  it('does not trust self-reported witness independence', () => {
    const b = buildBundle(quickstartBundleDraft('healthy'));
    const core = {
      ...b.core,
      quorum: {
        ...b.core.quorum,
        votes: b.core.quorum.votes.map((v) => ({ ...v, trustDomain: 'shared' })),
      },
    };
    expect(verifyBundle({ ...b, core, contentHash: hashCore(core) }).verified).toBe(false);
  });
  it('refuses an accepted-quorum pin taken on a C-Chain after ACP-194 activated', () => {
    const b = buildBundle(quickstartBundleDraft('healthy'));
    const helicon = 1_790_089_200;
    const supersededAt = (timestamp: number) => {
      const core = {
        ...b.core,
        chains: b.core.chains.map((c) =>
          c.evmChainId === '43114' ? { ...c, blockTimestamp: String(timestamp) } : c,
        ),
      };
      return verifyBundle({ ...b, core, contentHash: hashCore(core) }).findings.some(
        (f) => f.detail === 'Accepted-state basis superseded by ACP-194 on this chain.',
      );
    };
    expect(supersededAt(helicon - 1)).toBe(false);
    expect(supersededAt(helicon)).toBe(true);
  });
  it('verifies a settled-quorum pin on the same C-Chain after activation', () => {
    const b = buildBundle(quickstartBundleDraft('healthy'));
    const core = {
      ...b.core,
      chains: b.core.chains.map((c) => ({
        ...c,
        blockTimestamp: '1790089200',
        finalityBasis: 'settled-quorum',
      })),
    };
    expect(verifyBundle({ ...b, core, contentHash: hashCore(core) }).verified).toBe(true);
    const unnamed = {
      ...core,
      chains: core.chains.map((c) => ({ ...c, finalityBasis: 'latest' })),
    };
    expect(verifyBundle({ ...b, core: unnamed, contentHash: hashCore(unnamed) }).verified).toBe(
      false,
    );
  });
  it('binds the state-call result to the arithmetic observation', () => {
    const b = buildBundle(quickstartBundleDraft('healthy'));
    const core = { ...b.core, stateCalls: b.core.stateCalls.map((c) => ({ ...c, result: '999' })) };
    expect(verifyBundle({ ...b, core, contentHash: hashCore(core) }).verified).toBe(false);
  });
  it.each([
    'https://rpc.invalid/token123',
    'postgres://user:secret@db/x',
    'Bearer abc',
    'Basic dXNlcjpwYXNz',
  ])('blocks credential canaries in presentation too: %s', (canary) => {
    const b = buildBundle(quickstartBundleDraft('healthy'));
    const leaked = { ...b, presentation: { ...b.presentation, locale: canary } };
    expect(() => {
      assertBundleShareable(leaked);
    }).toThrow();
    expect(verifyBundle(leaked).verified).toBe(false);
    expect(renderHtml(leaked)).not.toContain(canary);
  });
  it('decodes uint256 exactly and rejects malformed numeric input', () => {
    const raw = JSON.parse(
      canonicalStringify(quickstartBundleDraft('healthy').core.replay.input),
    ) as { remotes: { transferredBalance: string }[] };
    const r = raw.remotes[0]!;
    r.transferredBalance = ((1n << 256n) - 1n).toString();
    expect(decodeProofInput(raw).remotes[0]?.transferredBalance).toBe((1n << 256n) - 1n);
    for (const invalid of ['01', '-1', '1e3', (1n << 256n).toString()]) {
      r.transferredBalance = invalid;
      expect(() => decodeProofInput(raw)).toThrow();
    }
  });
  it('normalises keys before sorting, rejects NFC collisions and non-JSON objects', () => {
    expect(canonicalStringify({ 'e\u0301': 'a', z: 'b' })).toBe(
      canonicalStringify({ z: 'b', é: 'a' }),
    );
    expect(() => canonicalStringify({ é: 'a', 'e\u0301': 'b' })).toThrow();
    expect(() => canonicalStringify(new Map())).toThrow();
    expect(() => canonicalStringify(new Date())).toThrow();
  });
});
