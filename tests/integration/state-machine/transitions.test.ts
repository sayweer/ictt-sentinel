import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AT,
  HOME_CHAIN,
  MESSENGER,
  REMOTE_CHAIN,
  doubleEffect,
  failedThenRetried,
  happyPath,
  messageKey,
  sendRetried,
} from '@ictt-sentinel/testkit';
import { type TransitionInput, deriveState, reduceAll } from '@ictt-sentinel/state-machine';
import {
  DuplicateEconomicEffectError,
  type TransitionRow,
  countEconomicEffects,
  ingestBatch,
  readTransitions,
  writeTransitionBatch,
} from '@ictt-sentinel/storage-postgres';
import {
  CHAIN,
  DEPLOYMENT,
  createTestDatabase,
  seedReference,
} from '../storage-postgres/harness.js';
import type { TestDatabase } from '../storage-postgres/harness.js';

/**
 * Transaction-atomic persistence of derived transitions, against a real
 * PostgreSQL. The rules under test here are the ones the database enforces
 * rather than the application: composite route identity and one credited
 * economic effect per route.
 */

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase('transitions');
  await seedReference(db.migrator);
}, 60_000);

afterAll(async () => {
  await db.drop();
});

const CTX = { evaluatedAt: AT(600), staleAfterMs: 30 * 60 * 1000 };

/** chain_logs requires its block, and message_transitions requires its log. */
const seedFacts = async (inputs: readonly TransitionInput[]): Promise<void> => {
  const byBlock = new Map<string, TransitionInput>();
  for (const i of inputs) byBlock.set(i.fact.blockHash, i);

  await ingestBatch(db.runtime, {
    deploymentId: DEPLOYMENT,
    chainKey: CHAIN,
    blocks: [...byBlock.values()].map((i) => ({
      chainKey: CHAIN,
      blockHash: i.fact.blockHash,
      blockNumber: i.position.blockNumber,
      parentHash: i.fact.blockHash,
      blockTimestamp: 1_700_000_000n,
      observedClass: 'accepted' as const,
      observedAt: AT(0),
    })),
    logs: inputs.map((i) => ({
      chainKey: CHAIN,
      blockHash: i.fact.blockHash,
      txHash: i.fact.txHash,
      logIndex: i.fact.logIndex,
      blockNumber: i.position.blockNumber,
      txIndex: 0,
      address: `0x${'77'.repeat(20)}`,
      topics: [`0x${'01'.repeat(32)}`],
      data: '0x',
      observedAt: AT(0),
    })),
  });
};

const toRow = (i: TransitionInput): TransitionRow => ({
  transitionId: createHash('sha256')
    .update(
      [
        i.message.sourceBlockchainId,
        i.message.destinationBlockchainId,
        i.message.teleporterMessengerAddress,
        String(i.message.registryProtocolVersion),
        i.message.messageId,
        i.kind,
        // The raw fact is part of the id: two distinct executions of one route
        // are two transitions, and collapsing them would hide the second credit.
        i.fact.blockHash,
        i.fact.txHash,
        String(i.fact.logIndex),
      ].join('|'),
    )
    .digest('hex'),
  deploymentId: DEPLOYMENT,
  sourceBlockchainId: i.message.sourceBlockchainId,
  destinationBlockchainId: i.message.destinationBlockchainId,
  messengerAddress: i.message.teleporterMessengerAddress,
  registryProtocolVersion: i.message.registryProtocolVersion,
  messageId: i.message.messageId,
  transitionKind: i.kind,
  chainKey: CHAIN,
  blockHash: i.fact.blockHash,
  txHash: i.fact.txHash,
  logIndex: i.fact.logIndex,
  observedAt: AT(0),
  envelopeId: i.envelopeId ?? null,
  carriesEconomicEffect: i.carriesEconomicEffect === true,
});

/** Mark the destination effect, the way the projection layer would. */
const withEffect = (inputs: readonly TransitionInput[]): readonly TransitionInput[] =>
  inputs.map((i) =>
    i.kind === 'execution-succeeded' || i.kind === 'execution-retried'
      ? { ...i, carriesEconomicEffect: true }
      : { ...i, carriesEconomicEffect: false },
  );

describe('transaction-atomic persistence', () => {
  it('writes a whole message lifecycle and reads it back', async () => {
    const inputs = withEffect(happyPath());
    await seedFacts(inputs);
    const written = await writeTransitionBatch(db.runtime, inputs.map(toRow));
    expect(written).toBe(inputs.length);

    const stored = await readTransitions(db.runtime, {
      sourceBlockchainId: HOME_CHAIN,
      destinationBlockchainId: REMOTE_CHAIN,
      messengerAddress: MESSENGER,
      registryProtocolVersion: 1,
      messageId: messageKey().messageId,
    });
    expect(stored.map((s) => s.transitionKind).sort()).toEqual(inputs.map((i) => i.kind).sort());
  });

  it('is idempotent: re-writing the same batch adds nothing', async () => {
    const inputs = withEffect(happyPath());
    expect(await writeTransitionBatch(db.runtime, inputs.map(toRow))).toBe(0);
    expect(await countEconomicEffects(db.runtime, messageKey().messageId)).toBe(1);
  });

  it('rolls the whole batch back when one row is invalid', async () => {
    const key = messageKey({ messageId: `0x${'5'.repeat(64)}` });
    const inputs = withEffect(happyPath(key));
    await seedFacts(inputs);

    const rows = inputs.map(toRow);
    const broken: TransitionRow[] = [
      ...rows.slice(0, 2),
      // A log that was never ingested: the foreign key fails mid-batch.
      { ...rows[2]!, txHash: `0x${'f'.repeat(64)}` },
    ];
    await expect(writeTransitionBatch(db.runtime, broken)).rejects.toThrow();

    // Nothing from the batch survived.
    const stored = await readTransitions(db.runtime, {
      sourceBlockchainId: key.sourceBlockchainId,
      destinationBlockchainId: key.destinationBlockchainId,
      messengerAddress: key.teleporterMessengerAddress,
      registryProtocolVersion: key.registryProtocolVersion,
      messageId: key.messageId,
    });
    expect(stored).toEqual([]);
  });
});

describe('one economic effect per route, enforced by the database', () => {
  it('refuses a second credited effect', async () => {
    const key = messageKey({ messageId: `0x${'6'.repeat(64)}` });
    const inputs = withEffect(doubleEffect(key));
    await seedFacts(inputs);

    // The derived state already reports the breach.
    const derived = deriveState(reduceAll(key, inputs), CTX);
    expect(derived.duplicateEffectFacts).toHaveLength(2);
    expect(derived.verdict).toBe('CRITICAL');

    // And the database refuses to store it as two credits.
    await expect(writeTransitionBatch(db.runtime, inputs.map(toRow))).rejects.toThrow(
      DuplicateEconomicEffectError,
    );
    expect(await countEconomicEffects(db.runtime, key.messageId)).toBe(0);
  });

  it('allows a send retry, which is another attempt and not another effect', async () => {
    const key = messageKey({ messageId: `0x${'7'.repeat(64)}` });
    const inputs = withEffect(sendRetried(key));
    await seedFacts(inputs);

    await writeTransitionBatch(db.runtime, inputs.map(toRow));
    expect(await countEconomicEffects(db.runtime, key.messageId)).toBe(1);

    const derived = deriveState(reduceAll(key, inputs), CTX);
    expect(derived.sendAttempts).toBe(2);
    expect(derived.effect.count).toBe(1);
  });

  it('allows a failure followed by a successful retry, still one effect', async () => {
    const key = messageKey({ messageId: `0x${'8'.repeat(64)}` });
    // Only the retry that succeeded carries the effect.
    const inputs = failedThenRetried(key).map((i) => ({
      ...i,
      carriesEconomicEffect: i.kind === 'execution-retried',
    }));
    await seedFacts(inputs);

    await writeTransitionBatch(db.runtime, inputs.map(toRow));
    expect(await countEconomicEffects(db.runtime, key.messageId)).toBe(1);

    const derived = deriveState(reduceAll(key, inputs), CTX);
    expect(derived.state).toBe('RETRIED_SUCCESS');
    expect(derived.executionAttempts).toBe(2);
    expect(derived.effect.count).toBe(1);
  });
});

describe('composite route identity in the database', () => {
  it('keeps the same messageId apart across registry protocol versions', async () => {
    const v1 = messageKey({ messageId: `0x${'a'.repeat(64)}` });
    const v2 = messageKey({ messageId: `0x${'a'.repeat(64)}`, registryProtocolVersion: 2 });

    const first = withEffect(happyPath(v1));
    const second = withEffect(happyPath(v2));
    await seedFacts(first);

    await writeTransitionBatch(db.runtime, first.map(toRow));
    // Same messageId, different registry version: a distinct route, so this must
    // NOT collide with the one above.
    await writeTransitionBatch(db.runtime, second.map(toRow));

    expect(await countEconomicEffects(db.runtime, v1.messageId)).toBe(2);
    const v1Rows = await readTransitions(db.runtime, {
      sourceBlockchainId: v1.sourceBlockchainId,
      destinationBlockchainId: v1.destinationBlockchainId,
      messengerAddress: v1.teleporterMessengerAddress,
      registryProtocolVersion: 1,
      messageId: v1.messageId,
    });
    // Each route keeps exactly its own transitions.
    expect(v1Rows).toHaveLength(happyPath().length);
  });

  it('rejects a transition kind outside the semantic vocabulary', async () => {
    await expect(
      db.runtime.sql.unsafe(
        `insert into message_transitions
           (transition_id, deployment_id, source_blockchain_id, destination_blockchain_id,
            messenger_address, registry_protocol_version, message_id, transition_kind,
            chain_key, block_hash, tx_hash, log_index, observed_at)
         values ('bogus', '${DEPLOYMENT}', '${HOME_CHAIN}', '${REMOTE_CHAIN}', '${MESSENGER}',
                 1, '0x${'a'.repeat(64)}', 'EXECUTED_SUCCESS',
                 '${CHAIN}', '0x${'0'.repeat(64)}', '0x${'0'.repeat(64)}', 0, now())`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
