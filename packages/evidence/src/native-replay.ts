import {
  aggregate,
  assessNative,
  type NativeInput,
  type ProofInput,
  type AggregationInput,
} from '@ictt-sentinel/invariant-core';
import { canonicalStringify, type CanonicalValue } from './canonical.js';
import { decodeProofInput, encodeProofInput, replayProof } from './replay.js';
import type { RuleRecord, VerdictRecord } from './schema.js';

const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('expected native object');
  return value as Record<string, unknown>;
};
const boolean = (v: unknown): boolean => {
  if (typeof v !== 'boolean') throw new Error('expected boolean');
  return v;
};
const amount = (v: unknown): bigint | null => {
  if (v === null) return null;
  if (
    typeof v !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(v) ||
    v.length > 78 ||
    BigInt(v) >= 1n << 256n
  )
    throw new Error('invalid native uint256');
  return BigInt(v);
};
const count = (v: unknown): number => {
  const n = amount(v);
  if (n === null || n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('invalid native count');
  return Number(n);
};
export const decodeNativeInput = (value: unknown): NativeInput => {
  const v = record(value),
    c = record(v['components']),
    m = record(v['census']),
    f = record(v['feeReporting']);
  const holders = m['unexpectedRoleHolders'];
  if (
    !Array.isArray(holders) ||
    !holders.every((a) => typeof a === 'string' && /^0x[0-9a-f]{40}$/.test(a))
  )
    throw new Error('invalid role holder');
  const input: NativeInput = {
    components: {
      totalMinted: amount(c['totalMinted']),
      initialReserveImbalance: amount(c['initialReserveImbalance']),
      burnedTxFeesAddressBalance: amount(c['burnedTxFeesAddressBalance']),
      burnedForTransferAddressBalance: amount(c['burnedForTransferAddressBalance']),
      componentsFresh: boolean(c['componentsFresh']),
      fingerprintRecognised: boolean(c['fingerprintRecognised']),
    },
    census: {
      manifestRosterProvided: boolean(m['manifestRosterProvided']),
      genesisChainConfigRead: boolean(m['genesisChainConfigRead']),
      activationRulesKnown: boolean(m['activationRulesKnown']),
      roleHistoryCompleteFromActivation: boolean(m['roleHistoryCompleteFromActivation']),
      allCandidateRolesRead: boolean(m['allCandidateRolesRead']),
      unexpectedRoleHolders: holders as string[],
      unauthorisedMintObserved: boolean(m['unauthorisedMintObserved']),
      epochsCovered: count(m['epochsCovered']),
      epochsExpected: count(m['epochsExpected']),
    },
    feeReporting: {
      reportedRewardAlreadyInTotalMinted: boolean(f['reportedRewardAlreadyInTotalMinted']),
      duplicateReportObserved: boolean(f['duplicateReportObserved']),
      openReportEnvelopes: count(f['openReportEnvelopes']),
    },
    eligibleHomeCoverage: amount(v['eligibleHomeCoverage']),
    trustworthySupplyLowerBound: amount(v['trustworthySupplyLowerBound']),
    collateralNeeded: amount(v['collateralNeeded']),
    acceptedCollateral: amount(v['acceptedCollateral']),
  };
  if (canonicalStringify(input) !== canonicalStringify(value))
    throw new Error('unknown native input field');
  return input;
};
export const encodeNativeReplay = (context: ProofInput, native: NativeInput): CanonicalValue =>
  JSON.parse(
    canonicalStringify({ engine: 'native-upper-bound/v1', context, native }),
  ) as CanonicalValue;

export const decodeReplayInput = (
  value: unknown,
): { context: ProofInput; native: NativeInput | null } => {
  const v = record(value);
  if (v['engine'] === undefined) return { context: decodeProofInput(value), native: null };
  if (
    v['engine'] !== 'native-upper-bound/v1' ||
    Object.keys(v).sort().join(',') !== 'context,engine,native'
  )
    throw new Error('unsupported replay engine');
  return { context: decodeProofInput(v['context']), native: decodeNativeInput(v['native']) };
};

export const replayNative = (context: ProofInput, native: NativeInput) => {
  const evaluation = assessNative(native);
  const amounts = native.components;
  const invalidBound =
    amounts.totalMinted !== null &&
    amounts.initialReserveImbalance !== null &&
    amounts.burnedTxFeesAddressBalance !== null &&
    amounts.burnedForTransferAddressBalance !== null &&
    amounts.burnedTxFeesAddressBalance + amounts.burnedForTransferAddressBalance >
      amounts.totalMinted + amounts.initialReserveImbalance;
  const divergent =
    context.freshness.independentWitnessGroups < context.freshness.requiredWitnessGroups;
  const uncertain =
    evaluation.assessment !== 'sufficient' || invalidBound || native.census.epochsExpected === 0;
  const aggregation: AggregationInput = {
    contributions: [
      {
        ruleId: 'ACC-NATIVE-UPPER-BOUND',
        result: evaluation.critical ? 'FAIL' : uncertain ? 'UNKNOWN' : 'PASS',
        critical: evaluation.critical,
        required: true,
        claimMode:
          evaluation.assessment === 'sufficient' && !uncertain
            ? 'SUFFICIENT_UPPER_BOUND'
            : 'INDETERMINATE',
        reasons: evaluation.reasons,
      },
    ],
    dataStatus: divergent
      ? 'DIVERGENT'
      : !context.freshness.fresh
        ? 'STALE'
        : context.census !== 'complete-from-deployment-block'
          ? 'PARTIAL'
          : 'COMPLETE',
    coverage:
      context.untrackedRemotes.length > 0 ? 'PARTIAL' : divergent ? 'UNVERIFIED' : 'COMPLETE',
    missingRequiredEvaluations: [],
    previousOkExpired: !context.freshness.fresh,
    evaluationFaults:
      invalidBound || native.census.epochsExpected === 0
        ? ['invalid-native-bound-or-activation-epoch']
        : [],
  };
  const result = aggregate(aggregation);
  const verdict: VerdictRecord = {
    protocolStatus: result.protocolStatus,
    dataStatus: result.dataStatus,
    claimMode: result.claimMode,
    coverage: result.coverage,
    reasonCodes: result.reasonCodes,
    criticalRuleIds: result.criticalRuleIds,
    unknownRuleIds: result.unknownRuleIds,
  };
  const rule: RuleRecord = {
    ruleId: 'ACC-NATIVE-UPPER-BOUND',
    ruleVersion: 'native-upper-bound@1',
    result: aggregation.contributions[0]?.result ?? 'UNKNOWN',
    reasonCodes: evaluation.reasons,
    inputs: { proof: canonicalStringify(encodeNativeReplay(context, native)) },
    intermediates: { native: canonicalStringify(evaluation) },
    unit: 'native-base-units; reported upper bound only',
    floor: null,
    ceil: null,
    dust: null,
  };
  return {
    evaluation: JSON.parse(canonicalStringify(evaluation)) as CanonicalValue,
    aggregation,
    verdict,
    rule,
  };
};
export const replayEvaluation = (value: unknown) => {
  const { context, native } = decodeReplayInput(value);
  return native === null ? replayProof(context) : replayNative(context, native);
};
export const encodeReplayInput = (
  context: ProofInput,
  native: NativeInput | null,
): CanonicalValue =>
  native === null ? encodeProofInput(context) : encodeNativeReplay(context, native);
