import {
  assessDrift,
  assessMinterCensus,
  assessNative,
  classifyDiscoveredRemote,
  type DriftObservation,
} from '@ictt-sentinel/invariant-core';
import {
  classifyFingerprint,
  familyFromRegistryVersion,
  isInterpretable,
  resolveAdapter,
  type ObservedContract,
} from '@ictt-sentinel/ictt-adapters';
import { nativeInput } from '@ictt-sentinel/testkit';
import type { Scenario } from '../registry.js';

/**
 * Protocol-shape and native-mode faults.
 *
 * Two families of mistake this product must never make:
 *
 *   Reading a registry protocol version as an ABI family. `teleporterV2` is a
 *   separate, unaudited source tree; a version number says nothing about which
 *   tree is deployed (docs/PROTOCOL_SOURCE_LOCK.md 4).
 *
 *   Reporting the native reported supply as an exact figure. `U` is an
 *   accounting reconstruction with an unbacked initial reserve, so only
 *   `sufficient` / `indeterminate` / `unknown` are sayable (docs/INVARIANTS.md 7).
 */

const observed = (o: Partial<ObservedContract> = {}): ObservedContract => ({
  address: `0x${'cc'.repeat(20)}`,
  runtimeCodeHash: `0x${'ab'.repeat(32)}`,
  ...o,
});

const drift = (o: Partial<DriftObservation> & { control: DriftObservation['control'] }): DriftObservation => ({
  status: 'drift',
  expected: 'approved',
  observed: 'different',
  required: true,
  ...o,
});

export const protocolScenarios: readonly Scenario[] = [
  {
    id: 'protocol/registry-version-2-is-not-teleporter-v2',
    title: 'Registry protocol version 2 does not select the experimental ABI tree',
    corpus: 'unsupported',
    provenance: 'CLAUDE.md 5; docs/PROTOCOL_SOURCE_LOCK.md 4',
    pinned: { registryProtocolVersion: '2' },
    expect: { holds: ['not-teleporter-v2', 'not-interpretable'] },
    run: () => {
      // The function exists in order to refuse. A registry version is a number
      // on a registry contract; the ABI family comes from the implementation
      // fingerprint, and deriving one from the other is the mistake that would
      // select an unaudited source tree.
      let refused = false;
      try {
        familyFromRegistryVersion(2);
      } catch {
        refused = true;
      }
      return {
        holds: [
          ...(refused ? ['not-teleporter-v2'] : []),
          ...(isInterpretable('teleporter-v2-experimental') ? [] : ['not-interpretable']),
        ],
      };
    },
  },
  {
    id: 'protocol/teleporter-v2-family-refused',
    title: 'The experimental source tree resolves to unsupported, never to a guess',
    corpus: 'unsupported',
    provenance: 'docs/PROTOCOL_SOURCE_LOCK.md 4; CLAUDE.md 5',
    pinned: { family: 'teleporter-v2-experimental' },
    expect: { holds: ['not-interpretable'] },
    run: () => ({
      holds: isInterpretable('teleporter-v2-experimental') ? [] : ['not-interpretable'],
    }),
  },
  {
    id: 'protocol/unknown-runtime-code',
    title: 'Runtime code that matches no approved hash is unrecognised',
    corpus: 'fingerprint',
    provenance: 'docs/SUPPORT_MATRIX.md; fingerprint classification',
    pinned: { runtimeCode: '0x6080604052 (unknown)', approvedHashes: 'none' },
    expect: { holds: ['not-recognised'] },
    run: () => {
      const result = classifyFingerprint(observed(), []);
      return {
        holds: result.class === 'recognised' ? [] : ['not-recognised'],
        reasonCodes: [`FINGERPRINT_${result.class.toUpperCase().replace(/-/g, '_')}`],
      };
    },
  },
  {
    id: 'protocol/proxy-implementation-drift',
    title: 'A moved implementation slot is confirmed drift on a critical control',
    corpus: 'fingerprint',
    provenance: 'docs/RUNBOOK.md 11 (verdict-baseline-drift); CFG-D01',
    pinned: { control: 'proxy-implementation-slot' },
    expect: { reasonCodes: ['CFG-D01-BASELINE-DRIFT'], holds: ['confirmed-drift'] },
    run: () => {
      const result = assessDrift([drift({ control: 'proxy-implementation-slot' })]);
      return {
        reasonCodes: [...result.reasons],
        holds: result.confirmedDrift.length > 0 ? ['confirmed-drift'] : [],
      };
    },
  },
  {
    id: 'protocol/proxy-admin-and-beacon-drift',
    title: 'Admin and beacon slots are separate controls and both raise drift',
    corpus: 'fingerprint',
    provenance: 'docs/RUNBOOK.md 11; CFG-D01',
    pinned: { controls: 'proxy-admin-slot, proxy-beacon-slot' },
    expect: { reasonCodes: ['CFG-D01-BASELINE-DRIFT'], holds: ['two-controls'] },
    run: () => {
      const result = assessDrift([
        drift({ control: 'proxy-admin-slot' }),
        drift({ control: 'proxy-beacon-slot' }),
      ]);
      return {
        reasonCodes: [...result.reasons],
        holds: result.confirmedDrift.length === 2 ? ['two-controls'] : [],
      };
    },
  },
  {
    id: 'protocol/unresolved-control-is-not-a-match',
    title: 'A control that could not be read is never counted as matching',
    corpus: 'fingerprint',
    provenance: 'CLAUDE.md 4; CFG-D03',
    pinned: { control: 'implementation-code-hash', status: 'unknown' },
    expect: { reasonCodes: ['CFG-D03-CONTROL-UNRESOLVED'] },
    run: () => {
      const result = assessDrift([
        drift({ control: 'implementation-code-hash', status: 'unknown', observed: null }),
      ]);
      return { reasonCodes: [...result.reasons] };
    },
  },
  {
    id: 'protocol/discovered-remote-is-a-candidate',
    title: 'A permissionlessly discovered remote is a candidate, never trusted',
    corpus: 'fingerprint',
    provenance: 'CLAUDE.md 5; CFG-D02',
    pinned: { approvedInManifest: 'false' },
    expect: { reasonCodes: ['CFG-D02-UNAPPROVED-CANDIDATE'], holds: ['candidate'] },
    run: () => {
      const status = classifyDiscoveredRemote(false);
      const result = assessDrift([
        drift({ control: 'contract-address', status, required: false }),
      ]);
      return {
        reasonCodes: [...result.reasons],
        holds: status === 'candidate' ? ['candidate'] : [],
      };
    },
  },
  {
    id: 'protocol/adapter-resolution-refuses-unknown-shape',
    title: 'An adapter is resolved from the source lock or not at all',
    corpus: 'unsupported',
    provenance: 'docs/PROTOCOL_SOURCE_LOCK.md; adapter registry',
    pinned: { family: 'teleporter-v2-experimental', approvedHashes: 'none' },
    expect: { holds: ['unresolved'] },
    run: () => {
      const resolution = resolveAdapter(observed(), [], 'teleporter-v2-experimental');
      return {
        holds: resolution.outcome === 'resolved' ? [] : ['unresolved'],
        reasonCodes: [`ADAPTER_${resolution.outcome.toUpperCase().replace(/-/g, '_')}`],
      };
    },
  },

  // ------------------------------------------------------------------ native

  {
    id: 'native/upper-bound-covered',
    title: 'U below coverage is sufficient, and never an exact supply claim',
    corpus: 'operational',
    provenance: 'docs/INVARIANTS.md 7; docs/PROTOCOL_SOURCE_LOCK.md 5.1',
    pinned: { totalMinted: '1000', reserve: '200', burned: '200', coverage: '1200' },
    expect: { holds: ['sufficient'] },
    run: () => {
      const result = assessNative(nativeInput());
      return {
        holds: [result.assessment],
        reasonCodes: [...result.reasons],
      };
    },
  },
  {
    id: 'native/upper-bound-exceeds-coverage',
    title: 'U above coverage is indeterminate, not a shortfall',
    corpus: 'gap',
    provenance: 'CLAUDE.md 5; docs/RUNBOOK.md 11 (verdict-native-bound)',
    pinned: { U: '1000', coverage: '900' },
    // An unobserved fee burn may already have reduced real supply, so this is
    // explicitly not a red economic verdict.
    expect: { holds: ['indeterminate'] },
    run: () => {
      const result = assessNative(nativeInput({ eligibleHomeCoverage: 900n }));
      return { holds: [result.assessment], reasonCodes: [...result.reasons] };
    },
  },
  {
    id: 'native/incomplete-minter-census',
    title: 'A minter census missing a required part cannot support a bound',
    corpus: 'gap',
    provenance: 'docs/INVARIANTS.md; CFG-N03',
    pinned: { roleHistoryCompleteFromActivation: 'false' },
    expect: { holds: ['unknown'] },
    run: () => {
      const result = assessNative(
        nativeInput({ census: { roleHistoryCompleteFromActivation: false } }),
      );
      return { holds: [result.assessment], reasonCodes: [...result.reasons] };
    },
  },
  {
    id: 'native/unexpected-minter-role',
    title: 'A minter nobody approved blocks the exclusivity assumption',
    corpus: 'gap',
    provenance: 'docs/INVARIANTS.md 7; minter exclusivity',
    pinned: { unexpectedRoleHolders: '1' },
    expect: { holds: ['census-not-established'] },
    run: () => {
      const census = assessMinterCensus({
        manifestRosterProvided: true,
        genesisChainConfigRead: true,
        activationRulesKnown: true,
        roleHistoryCompleteFromActivation: true,
        allCandidateRolesRead: true,
        unexpectedRoleHolders: [`0x${'77'.repeat(20)}`],
        unauthorisedMintObserved: false,
        epochsCovered: 1,
        epochsExpected: 1,
      });
      return {
        holds: census.established ? [] : ['census-not-established'],
        reasonCodes: [...census.reasons],
      };
    },
  },
  {
    id: 'native/missing-epoch-coverage',
    title: 'A precompile disable and re-enable leaves an epoch uncovered',
    corpus: 'gap',
    provenance: 'docs/PROTOCOL_SOURCE_LOCK.md; activation epochs',
    pinned: { epochsCovered: '1', epochsExpected: '3' },
    expect: { holds: ['census-not-established'] },
    run: () => {
      const census = assessMinterCensus({
        manifestRosterProvided: true,
        genesisChainConfigRead: true,
        activationRulesKnown: true,
        roleHistoryCompleteFromActivation: true,
        allCandidateRolesRead: true,
        unexpectedRoleHolders: [],
        unauthorisedMintObserved: false,
        epochsCovered: 1,
        epochsExpected: 3,
      });
      return {
        holds: census.established ? [] : ['census-not-established'],
        reasonCodes: [...census.reasons],
      };
    },
  },
  {
    id: 'native/unauthorised-mint-observed',
    title: 'An unauthorised mint is a breach of the exclusivity the bound rests on',
    corpus: 'deterministic-breach',
    provenance: 'docs/INVARIANTS.md 7',
    pinned: { unauthorisedMintObserved: 'true' },
    expect: { holds: ['census-not-established'] },
    run: () => {
      const census = assessMinterCensus({
        manifestRosterProvided: true,
        genesisChainConfigRead: true,
        activationRulesKnown: true,
        roleHistoryCompleteFromActivation: true,
        allCandidateRolesRead: true,
        unexpectedRoleHolders: [],
        unauthorisedMintObserved: true,
        epochsCovered: 1,
        epochsExpected: 1,
      });
      return {
        holds: census.established ? [] : ['census-not-established'],
        reasonCodes: [...census.reasons],
      };
    },
  },
  {
    id: 'native/duplicate-fee-burn-report',
    title: 'A repeated burned-fee report is not counted twice',
    corpus: 'gap',
    provenance: 'docs/PROTOCOL_SOURCE_LOCK.md T04',
    pinned: { duplicateReportObserved: 'true' },
    // The bound is refused rather than netted out: a delta reported twice would
    // inflate it, and inflating an upper bound is how a shortfall hides.
    expect: { reasonCodes: ['CFG-N04-DUPLICATE-FEE-REPORT'] },
    run: () => {
      const result = assessNative(nativeInput({ feeReporting: { duplicateReportObserved: true } }));
      return { holds: [result.assessment], reasonCodes: [...result.reasons] };
    },
  },
  {
    id: 'native/reward-already-in-total-minted',
    title: 'The re-minted reward is not added a second time',
    corpus: 'gap',
    provenance: 'docs/PROTOCOL_SOURCE_LOCK.md T04',
    pinned: { reportedRewardAlreadyInTotalMinted: 'false' },
    // If the re-mint is not already inside totalMinted then the pinned semantics
    // the bound was derived from do not hold on this chain at all.
    expect: { holds: ['unknown'], reasonCodes: ['CFG-N05-FEE-REMINT-SEMANTICS-UNVERIFIED'] },
    run: () => {
      const result = assessNative(
        nativeInput({ feeReporting: { reportedRewardAlreadyInTotalMinted: false } }),
      );
      return { holds: [result.assessment], reasonCodes: [...result.reasons] };
    },
  },
  {
    id: 'native/stale-components',
    title: 'Supply components that are not fresh cannot support any assessment',
    corpus: 'gap',
    provenance: 'docs/INVARIANTS.md; freshness',
    pinned: { componentsFresh: 'false' },
    expect: { holds: ['unknown'] },
    run: () => {
      const result = assessNative(nativeInput({ components: { componentsFresh: false } }));
      return { holds: [result.assessment], reasonCodes: [...result.reasons] };
    },
  },
];
