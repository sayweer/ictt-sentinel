import { describe, expect, it } from 'vitest';
import { nativeInput, quickstartBundleDraft } from '@ictt-sentinel/testkit';
import {
  buildBundle,
  decodeProofInput,
  encodeNativeReplay,
  replayEvaluation,
  domainSeparatedSha256,
  stateCallDigest,
  canonicalStringify,
  verifyBundle,
} from '../src/index.js';

const fixture = (coverage: bigint, lower: bigint | null = null) => {
  const base = quickstartBundleDraft('healthy');
  const context = decodeProofInput(base.core.replay.input);
  const native = nativeInput({
    eligibleHomeCoverage: coverage,
    trustworthySupplyLowerBound: lower,
  });
  const input = encodeNativeReplay(context, native),
    replay = replayEvaluation(input);
  const remote = base.core.fingerprints.find((f) => f.role === 'erc20-token-remote');
  const chain = base.core.chains.find((c) => c.blockchainId === remote?.blockchainId);
  if (!remote || !chain) throw new Error('fixture missing remote');
  const values = {
    ...Object.fromEntries(
      Object.entries(native.components)
        .filter(([, v]) => typeof v === 'bigint')
        .map(([k, v]) => [`native.components.${k}`, String(v)]),
    ),
    'native.eligibleHomeCoverage': String(coverage),
    'native.collateralNeeded': '0',
    'native.acceptedCollateral': '0',
    'native.census': canonicalStringify(native.census),
    'native.feeReporting': canonicalStringify(native.feeReporting),
    ...(lower === null ? {} : { 'native.trustworthySupplyLowerBound': String(lower) }),
  };
  return buildBundle({
    ...base,
    core: {
      ...base.core,
      replay: { input, evaluation: replay.evaluation },
      rules: [replay.rule],
      verdict: replay.verdict,
      fingerprints: base.core.fingerprints.map((f) =>
        f === remote ? { ...f, role: 'native-token-remote' } : f,
      ),
      stateCalls: Object.entries(values).map(([observationPath, result]) => ({
        ...base.core.stateCalls[0]!,
        blockchainId: chain.blockchainId,
        blockHash: chain.blockHash,
        blockNumber: chain.blockNumber,
        target: remote.address,
        calldata: '0x',
        calldataDigest: domainSeparatedSha256('ictt-sentinel/calldata/v1', '0x'),
        resultDigest: stateCallDigest(remote.address, '0x', result),
        result,
        observationPath,
        provenance: 'fictional native state and census transcript',
      })),
    },
  });
};
describe('native evidence replay', () => {
  it.each([
    [1200n, null, 'OK', 'SUFFICIENT_UPPER_BOUND'],
    [900n, null, 'UNKNOWN', 'INDETERMINATE'],
    [900n, 950n, 'CRITICAL', 'INDETERMINATE'],
  ] as const)('reproduces bound %s', (coverage, lower, status, claim) => {
    const bundle = fixture(coverage, lower);
    expect(bundle.core.verdict).toMatchObject({ protocolStatus: status, claimMode: claim });
    expect(verifyBundle(JSON.parse(JSON.stringify(bundle))).verified).toBe(true);
  });
  it('cannot omit a native component reference', () => {
    const b = fixture(1200n);
    const changed = buildBundle({
      ...b,
      core: {
        ...b.core,
        stateCalls: b.core.stateCalls.filter(
          (c) => c.observationPath !== 'native.components.totalMinted',
        ),
      },
    });
    expect(verifyBundle(changed).verified).toBe(false);
  });
});
