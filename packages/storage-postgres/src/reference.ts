import type { Manifest } from '@ictt-sentinel/config';
import { withTransaction, type Db, type Tx } from './client.js';

/**
 * Operator-curated reference rows: the deployment and its chains.
 *
 * Every fact, checkpoint and evaluation references these rows, and the runtime
 * role may only read them (0003_runtime_privileges). They are written here, by
 * the migrator, from a reviewed manifest - never inferred by the agent from
 * whatever it happens to be watching.
 */

/**
 * The key a chain is stored under.
 *
 * Namespaced by deployment because `chains.chain_key` is a global primary key and
 * two deployments watching the same chain are still two lanes. One definition:
 * the agent's watch plan uses this same function.
 */
export const chainKeyOf = (deploymentId: string, chainName: string): string =>
  `${deploymentId}/${chainName}`;

export interface ReferenceRows {
  readonly deployment: {
    readonly deploymentId: string;
    readonly manifestHash: string;
    readonly assetMode: 'canonical-erc20' | 'native';
  };
  readonly chains: readonly {
    readonly chainKey: string;
    readonly blockchainId: string;
    readonly evmChainId: bigint;
    readonly finalityMode: 'accepted-quorum' | 'settled-quorum';
  }[];
}

/**
 * The rows an approved manifest stands for. Pure.
 *
 * `manifestDigest` is the loader's `sha256:<hex>`; the column stores the bare hex.
 */
export const referenceRowsFor = (m: Manifest, manifestDigest: string): ReferenceRows => {
  const match = /^sha256:([0-9a-f]{64})$/.exec(manifestDigest);
  if (match?.[1] === undefined) throw new TypeError('manifest digest must be sha256:<64 hex>');
  const manifestHash = match[1];
  const deploymentId = m.metadata.name;
  const sides = [
    { name: m.spec.home.name, chain: m.spec.home.chain },
    ...m.spec.remotes.map((r) => ({ name: r.name, chain: r.chain })),
  ];
  return {
    deployment: { deploymentId, manifestHash, assetMode: m.spec.asset.mode },
    chains: sides.map((s) => ({
      chainKey: chainKeyOf(deploymentId, s.name),
      blockchainId: s.chain.blockchainId.toLowerCase(),
      evmChainId: BigInt(s.chain.evmChainId),
      finalityMode: s.chain.finality.mode,
    })),
  };
};

export class ReferenceConflictError extends Error {
  override readonly name = 'ReferenceConflictError';
}

/**
 * Write the rows, idempotently.
 *
 * Registering the same manifest twice is a no-op. A row that already exists
 * with different content is refused rather than overwritten: facts already
 * recorded against it were recorded under that identity, and silently changing
 * it would re-label evidence.
 */
export const registerDeployment = async (
  db: Db,
  rows: ReferenceRows,
): Promise<{ readonly inserted: number }> =>
  withTransaction(db, async (tx: Tx) => {
    let inserted = 0;
    const d = rows.deployment;
    const created = await tx`
      insert into deployments (deployment_id, manifest_hash, asset_mode)
      values (${d.deploymentId}, ${d.manifestHash}, ${d.assetMode})
      on conflict do nothing
      returning deployment_id
    `;
    inserted += created.length;
    const [existing] = await tx<{ manifest_hash: string; asset_mode: string }[]>`
      select manifest_hash, asset_mode from deployments where deployment_id = ${d.deploymentId}
    `;
    if (existing?.manifest_hash !== d.manifestHash || existing.asset_mode !== d.assetMode)
      throw new ReferenceConflictError(
        `deployment ${d.deploymentId} is already registered under a different manifest`,
      );
    for (const c of rows.chains) {
      const made = await tx`
        insert into chains (chain_key, deployment_id, blockchain_id, evm_chain_id, finality_mode)
        values (${c.chainKey}, ${d.deploymentId}, ${c.blockchainId}, ${c.evmChainId.toString()},
                ${c.finalityMode})
        on conflict do nothing
        returning chain_key
      `;
      inserted += made.length;
      const [row] = await tx<
        {
          deployment_id: string;
          blockchain_id: string;
          evm_chain_id: string;
          finality_mode: string;
        }[]
      >`
        select deployment_id, blockchain_id, evm_chain_id::text, finality_mode
        from chains where chain_key = ${c.chainKey}
      `;
      if (
        row?.deployment_id !== d.deploymentId ||
        row.blockchain_id !== c.blockchainId ||
        row.evm_chain_id !== c.evmChainId.toString() ||
        row.finality_mode !== c.finalityMode
      )
        throw new ReferenceConflictError(
          `chain ${c.chainKey} is already registered with a different identity or finality`,
        );
    }
    return { inserted };
  });
