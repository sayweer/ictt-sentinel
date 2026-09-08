import type { Manifest, Policy } from '@ictt-sentinel/config';
import type { DeploymentPlan } from './runtime.js';
import type { ChainWiring } from './log-source.js';

/**
 * Turn a reviewed manifest and policy into a watch plan.
 *
 * Nothing is inferred that the operator did not approve. The start block is the
 * manifest's declared deployment block, not "wherever history still exists" on
 * whichever provider answered first, and the required witness count comes from
 * policy rather than from how many URLs happen to be configured
 * (docs/adr/0002-accepted-quorum-truth.md).
 */

export interface WatchPlan {
  readonly deployment: DeploymentPlan;
  readonly chains: readonly ChainWiring[];
}

/**
 * Chain key.
 *
 * Namespaced by deployment because `chains.chain_key` is a global primary key
 * and two deployments watching the same chain are still two lanes.
 */
export const chainKeyOf = (deploymentId: string, chainName: string): string =>
  `${deploymentId}/${chainName}`;

export const buildWatchPlan = (manifest: Manifest, policy: Policy): WatchPlan => {
  const deploymentId = manifest.metadata.name;
  const sides = [
    { name: manifest.spec.home.name, chain: manifest.spec.home.chain, from: manifest.spec.home.tokenHome.deploymentBlock },
    ...manifest.spec.remotes.map((r) => ({
      name: r.name,
      chain: r.chain,
      from: r.tokenRemote.deploymentBlock,
    })),
  ];

  const chains: ChainWiring[] = sides.map((side) => ({
    chainKey: chainKeyOf(deploymentId, side.name),
    endpoints: side.chain.endpoints,
    maxRangeBlocks: policy.spec.dataPath.maxLogRangeBlocks,
  }));

  return {
    chains,
    deployment: {
      deploymentId,
      maxHints: 32,
      freshness: {
        maxAgeSeconds: policy.spec.evidence.maxAgeSeconds,
        expiresAfterSeconds: policy.spec.evidence.expiresAfterSeconds,
      },
      chains: sides.map((side) => ({
        chainKey: chainKeyOf(deploymentId, side.name),
        config: {
          deploymentId,
          chainKey: chainKeyOf(deploymentId, side.name),
          startBlock: BigInt(side.from),
          agreement: {
            requiredIndependentGroups: policy.spec.quorum.minIndependentTrustDomains,
            // Only true when the manifest actually declares an archive witness.
            // Claiming an archive fallback that does not exist would let a range
            // count as covered on the strength of a capability nobody has.
            archiveFallbackDeclared: side.chain.endpoints.some(
              (e) => e.archiveDepth === 'full' && e.role === 'archive',
            ),
          },
          retryBudget: policy.spec.dataPath.maxRetries,
          freshnessTtlMs: policy.spec.evidence.maxAgeSeconds * 1000,
          maxHintsConsidered: 32,
        },
      })),
    },
  };
};
