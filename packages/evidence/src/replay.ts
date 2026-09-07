import {
  aggregate,
  evaluateCanonicalErc20,
  type ProofInput,
  type AggregationInput,
} from '@ictt-sentinel/invariant-core';
import { canonicalStringify, type CanonicalValue } from './canonical.js';
import { domainSeparatedSha256 } from './hash.js';
import type { RuleRecord, VerdictRecord } from './schema.js';

const object = (v: unknown): Record<string, unknown> => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('expected object');
  return v as Record<string, unknown>;
};
const text = (v: unknown): string => {
  if (typeof v !== 'string') throw new Error('expected string');
  return v;
};
const bool = (v: unknown): boolean => {
  if (typeof v !== 'boolean') throw new Error('expected boolean');
  return v;
};
const uint = (v: unknown): bigint => {
  const s = text(v);
  if (!/^(0|[1-9][0-9]*)$/.test(s) || s.length > 78 || BigInt(s) >= 1n << 256n)
    throw new Error('invalid uint256');
  return BigInt(s);
};
const count = (v: unknown): number => {
  const n = uint(v);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('invalid count');
  return Number(n);
};
const nullable = <T>(v: unknown, parse: (v: unknown) => T): T | null =>
  v === null ? null : parse(v);
const array = <T>(v: unknown, parse: (v: unknown) => T): T[] => {
  if (!Array.isArray(v)) throw new Error('expected array');
  return v.map(parse);
};
const choice = <T extends string>(v: unknown, choices: readonly T[]): T => {
  const s = text(v);
  if (!choices.includes(s as T)) throw new Error('unknown enum');
  return s as T;
};
const pin = (v: unknown) => {
  const p = object(v);
  return {
    blockchainId: text(p['blockchainId']),
    blockNumber: uint(p['blockNumber']),
    blockHash: text(p['blockHash']),
  };
};
/** Decode only named fields; never guess bigint from an arbitrary numeric-looking string. */
export const decodeProofInput = (value: unknown): ProofInput => {
  const v = object(value),
    p = object(v['provenance']),
    f = object(v['freshness']),
    h = object(v['homeEscrow']);
  const input: ProofInput = {
    deploymentId: text(v['deploymentId']),
    family: text(v['family']),
    provenance: {
      manifestHash: nullable(p['manifestHash'], text),
      policyHash: nullable(p['policyHash'], text),
      sourceLockCommitSha: nullable(p['sourceLockCommitSha'], text),
      adapterId: nullable(p['adapterId'], text),
      adapterVersion: nullable(p['adapterVersion'], count),
      ruleVersion: text(p['ruleVersion']),
    },
    census: choice(v['census'], ['complete-from-deployment-block', 'partial', 'unknown']),
    cut: choice(v['cut'], ['closed', 'open', 'gap']),
    untrackedRemotes: array(v['untrackedRemotes'], text),
    freshness: {
      fresh: bool(f['fresh']),
      independentWitnessGroups: count(f['independentWitnessGroups']),
      requiredWitnessGroups: count(f['requiredWitnessGroups']),
    },
    remotes: array(v['remotes'], (item) => {
      const r = object(item),
        s = object(r['scale']);
      return {
        remoteBlockchainId: text(r['remoteBlockchainId']),
        remoteAddress: text(r['remoteAddress']),
        transferredBalance: nullable(r['transferredBalance'], uint),
        remoteTotalSupply: nullable(r['remoteTotalSupply'], uint),
        scale: {
          tokenMultiplier: uint(s['tokenMultiplier']),
          multiplyOnRemote: bool(s['multiplyOnRemote']),
          homeDecimals: count(s['homeDecimals']),
          remoteDecimals: count(s['remoteDecimals']),
          established: bool(s['established']),
        },
        homePin: nullable(r['homePin'], pin),
        remotePin: nullable(r['remotePin'], pin),
        fingerprintRecognised: bool(r['fingerprintRecognised']),
        tokenBehaviourCanonical: bool(r['tokenBehaviourCanonical']),
        routeSingleHop: bool(r['routeSingleHop']),
        initialReserveImbalance: uint(r['initialReserveImbalance']),
      };
    }),
    pending: array(v['pending'], (item) => {
      const r = object(item);
      return {
        messageKey: text(r['messageKey']),
        direction: choice(r['direction'], ['home-to-remote', 'remote-to-home']),
        amount: uint(r['amount']),
        ageSeconds: count(r['ageSeconds']),
        remoteBlockchainId: text(r['remoteBlockchainId']),
        remoteAddress: text(r['remoteAddress']),
      };
    }),
    effects: array(v['effects'], (item) => {
      const r = object(item);
      return {
        messageKey: text(r['messageKey']),
        amount: uint(r['amount']),
        remoteBlockchainId: text(r['remoteBlockchainId']),
        remoteAddress: text(r['remoteAddress']),
        hasUniqueAuthorisedSource: bool(r['hasUniqueAuthorisedSource']),
        routeMatchesSource: bool(r['routeMatchesSource']),
        duplicateEffect: bool(r['duplicateEffect']),
        causalSourceFact: nullable(r['causalSourceFact'], text),
      };
    }),
    homeEscrow: {
      escrowBalance: nullable(h['escrowBalance'], uint),
      homePin: nullable(h['homePin'], pin),
      acceptedCollateralHomeUnits: uint(h['acceptedCollateralHomeUnits']),
    },
    pendingAgeLimitSeconds: count(v['pendingAgeLimitSeconds']),
  };
  if (canonicalStringify(input) !== canonicalStringify(value))
    throw new Error('unknown or noncanonical input field');
  return input;
};

/** Run arithmetic first. Aggregation contributions are derived, never caller assertions. */
export const replayProof = (input: ProofInput) => {
  const evaluation = evaluateCanonicalErc20(input, (s) =>
    domainSeparatedSha256('ictt-sentinel/proof-input/v1', s),
  );
  const divergent =
    input.freshness.independentWitnessGroups < input.freshness.requiredWitnessGroups;
  const aggregation: AggregationInput = {
    contributions: [
      {
        ruleId: evaluation.output.ruleId,
        result: evaluation.output.result,
        critical: evaluation.gateA.critical,
        required: true,
        claimMode:
          evaluation.output.result === 'UNKNOWN'
            ? 'INDETERMINATE'
            : evaluation.output.result === 'UNSUPPORTED'
              ? 'UNSUPPORTED'
              : 'CAUSAL_EXACT',
        reasons: evaluation.output.reasons,
      },
    ],
    dataStatus: divergent
      ? 'DIVERGENT'
      : !input.freshness.fresh
        ? 'STALE'
        : input.census !== 'complete-from-deployment-block'
          ? 'PARTIAL'
          : 'COMPLETE',
    coverage: divergent ? 'UNVERIFIED' : input.untrackedRemotes.length > 0 ? 'PARTIAL' : 'COMPLETE',
    missingRequiredEvaluations: input.remotes.length === 0 ? ['ACC-ERC20-CANONICAL'] : [],
    previousOkExpired: !input.freshness.fresh,
    evaluationFaults: [],
  };
  const {
    protocolStatus,
    dataStatus,
    claimMode,
    coverage,
    reasonCodes,
    criticalRuleIds,
    unknownRuleIds,
  } = aggregate(aggregation);
  const verdict: VerdictRecord = {
    protocolStatus,
    dataStatus,
    claimMode,
    coverage,
    reasonCodes,
    criticalRuleIds,
    unknownRuleIds,
  };
  const rule: RuleRecord = {
    ruleId: evaluation.output.ruleId,
    ruleVersion: evaluation.output.ruleVersion,
    result: evaluation.output.result,
    reasonCodes: evaluation.output.reasons,
    inputs: { proof: canonicalStringify(input) },
    intermediates: {
      gateA: canonicalStringify(evaluation.gateA),
      gateB: canonicalStringify(evaluation.gateB),
    },
    unit: 'remote-base-units; coverage and rounding in home-base-units',
    floor: evaluation.gateB.floorLiability.toString(),
    ceil: evaluation.gateB.conservativeLiability.toString(),
    dust: evaluation.gateB.totalDust.toString(),
  };
  return {
    evaluation: JSON.parse(canonicalStringify(evaluation)) as CanonicalValue,
    aggregation,
    verdict,
    rule,
  };
};

export const encodeProofInput = (input: ProofInput): CanonicalValue =>
  JSON.parse(canonicalStringify(input)) as CanonicalValue;
