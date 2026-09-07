import type { ReasonCode } from './reasons.js';

/**
 * Baseline drift.
 *
 * "Immutability" here does NOT mean chain state cannot physically change - it
 * obviously can. What the product checks is whether runtime has drifted from the
 * APPROVED manifest and policy. Every control below compares an observation
 * against an operator-approved expectation, and a difference is a finding, never
 * a silent update.
 *
 * A permissionlessly registered remote is the sharpest case: discovery is not
 * approval. It surfaces as a candidate for review and is never auto-trusted
 * (docs/DATA_MODEL.md 3.3).
 */

export const DRIFT_CONTROLS = [
  'runtime-vs-manifest',
  'proxy-implementation-slot',
  'proxy-beacon-slot',
  'proxy-admin-slot',
  'implementation-code-hash',
  'contract-address',
  'contract-role',
  'contract-linkage',
  'chain-identity',
  'chain-genesis',
  'token-decimals',
  'token-scaling',
  'minter-allowlist',
  'registrar-allowlist',
  'teleporter-registry',
  'teleporter-messenger',
  'teleporter-family',
  'teleporter-version',
  'registered-remote-census',
  'admin-upgrade-authority',
] as const;

export type DriftControl = (typeof DRIFT_CONTROLS)[number];

export const DRIFT_STATUSES = [
  /** Observed value matches the approved baseline. */
  'match',
  /** Observed value differs from the approved baseline. */
  'drift',
  /** Newly discovered and not approved. Review required; never auto-trusted. */
  'candidate',
  /** Could not be established. Never treated as a match. */
  'unknown',
] as const;
export type DriftStatus = (typeof DRIFT_STATUSES)[number];

export interface DriftObservation {
  readonly control: DriftControl;
  readonly status: DriftStatus;
  /** Approved value, from the manifest. Absent when nothing was approved. */
  readonly expected: string | null;
  /** Observed value at the pinned block. Absent when it could not be read. */
  readonly observed: string | null;
  /** False for controls the operator marked OBSERVE_ONLY in field policy. */
  readonly required: boolean;
}

export interface DriftResult {
  /** Required controls that differ from the approved baseline. */
  readonly confirmedDrift: readonly DriftObservation[];
  /** Discovered-but-unapproved items awaiting operator review. */
  readonly candidates: readonly DriftObservation[];
  /** Required controls that could not be established. */
  readonly unresolved: readonly DriftObservation[];
  readonly reasons: readonly ReasonCode[];
  /** A required control drifting is a deterministic configuration breach. */
  readonly critical: boolean;
  /** Every required control matched and none is unresolved. */
  readonly allRequiredEstablished: boolean;
}

/**
 * Controls whose drift is a configuration breach rather than a warning.
 *
 * These are the ones that change who can mint, what the money is, or which
 * contract the other side is actually talking to.
 */
const CRITICAL_CONTROLS: ReadonlySet<DriftControl> = new Set([
  'proxy-implementation-slot',
  'proxy-beacon-slot',
  'proxy-admin-slot',
  'implementation-code-hash',
  'contract-address',
  'contract-linkage',
  'chain-identity',
  'chain-genesis',
  'token-decimals',
  'token-scaling',
  'minter-allowlist',
  'admin-upgrade-authority',
]);

export const assessDrift = (observations: readonly DriftObservation[]): DriftResult => {
  const required = observations.filter((o) => o.required);

  const confirmedDrift = required.filter((o) => o.status === 'drift');
  const unresolved = required.filter((o) => o.status === 'unknown');
  // Candidates are reported whether or not the control is required: an
  // unapproved remote is exactly the thing an operator must see.
  const candidates = observations.filter((o) => o.status === 'candidate');

  const reasons: ReasonCode[] = [];
  if (confirmedDrift.length > 0) reasons.push('CFG-D01-BASELINE-DRIFT');
  if (candidates.length > 0) reasons.push('CFG-D02-UNAPPROVED-CANDIDATE');
  if (unresolved.length > 0) reasons.push('CFG-D03-CONTROL-UNRESOLVED');

  return {
    confirmedDrift,
    candidates,
    unresolved,
    reasons,
    critical: confirmedDrift.some((o) => CRITICAL_CONTROLS.has(o.control)),
    allRequiredEstablished: confirmedDrift.length === 0 && unresolved.length === 0,
  };
};

/**
 * A discovered remote is a candidate, never an approved baseline entry.
 *
 * Exported as a function so the rule is executable rather than a comment: there
 * is no argument that makes this return `match`.
 */
export const classifyDiscoveredRemote = (approvedInManifest: boolean): DriftStatus =>
  approvedInManifest ? 'match' : 'candidate';
