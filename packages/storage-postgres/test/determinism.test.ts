import { describe, expect, it } from 'vitest';
import { canonicalLogDigest, type LogFact } from '../src/ledger.js';
import { evaluationIdempotencyKey, type EvaluationInput } from '../src/evaluations.js';
import { loadMigrations } from '../src/migrate.js';

const hex = (n: number, len = 64) => `0x${n.toString(16).padStart(len, '0')}`;

const log = (blockNumber: bigint, txIndex: number, logIndex: number): LogFact => ({
  chainKey: 'home',
  blockHash: hex(Number(blockNumber)),
  txHash: hex(txIndex + 1000),
  logIndex,
  blockNumber,
  txIndex,
  address: hex(7, 40),
  topics: [hex(1)],
  data: '0x',
  observedAt: new Date('2026-01-01T00:00:00Z'),
});

describe('canonicalLogDigest', () => {
  const logs = [log(10n, 0, 0), log(10n, 0, 1), log(10n, 1, 0), log(11n, 0, 0)];

  it('is independent of arrival order', () => {
    const forward = canonicalLogDigest(logs);
    const reversed = canonicalLogDigest([...logs].reverse());
    const shuffled = canonicalLogDigest([logs[2]!, logs[0]!, logs[3]!, logs[1]!]);
    expect(reversed).toBe(forward);
    expect(shuffled).toBe(forward);
  });

  it('distinguishes a missing log', () => {
    expect(canonicalLogDigest(logs.slice(0, 3))).not.toBe(canonicalLogDigest(logs));
  });

  it('distinguishes two logs that differ only by log index', () => {
    expect(canonicalLogDigest([log(10n, 0, 0)])).not.toBe(canonicalLogDigest([log(10n, 0, 1)]));
  });

  it('separates records so concatenation cannot collide', () => {
    // Without a record terminator, ("ab", "c") and ("a", "bc") could hash alike.
    const a = canonicalLogDigest([log(1n, 0, 0), log(2n, 0, 0)]);
    const b = canonicalLogDigest([log(1n, 0, 0)]);
    expect(a).not.toBe(b);
  });

  it('is empty-set stable', () => {
    expect(canonicalLogDigest([])).toBe(canonicalLogDigest([]));
  });
});

describe('evaluationIdempotencyKey', () => {
  const base: EvaluationInput = {
    deploymentId: 'acme-usdc',
    subject: 'home.transferred-balance',
    policyVersion: 'policy-1',
    adapterVersion: 'adapter-1',
    pinnedBlocks: [
      { chainKey: 'home', blockNumber: 100n, blockHash: hex(100) },
      { chainKey: 'remote', blockNumber: 200n, blockHash: hex(200) },
    ],
    inputObservationDigests: ['a'.repeat(64), 'b'.repeat(64)],
  };

  it('is stable across input ordering', () => {
    const reordered: EvaluationInput = {
      ...base,
      pinnedBlocks: [...base.pinnedBlocks].reverse(),
      inputObservationDigests: [...base.inputObservationDigests].reverse(),
    };
    expect(evaluationIdempotencyKey(reordered)).toBe(evaluationIdempotencyKey(base));
  });

  it('is stable across repeated calls (no clock, no randomness)', () => {
    expect(evaluationIdempotencyKey(base)).toBe(evaluationIdempotencyKey(base));
  });

  it('changes when the pinned block hash changes at the same height', () => {
    const different: EvaluationInput = {
      ...base,
      pinnedBlocks: [
        { chainKey: 'home', blockNumber: 100n, blockHash: hex(999) },
        base.pinnedBlocks[1]!,
      ],
    };
    expect(evaluationIdempotencyKey(different)).not.toBe(evaluationIdempotencyKey(base));
  });

  it.each(['policyVersion', 'adapterVersion', 'subject', 'deploymentId'] as const)(
    'changes when %s changes',
    (field) => {
      const changed: EvaluationInput = { ...base, [field]: 'other' };
      expect(evaluationIdempotencyKey(changed)).not.toBe(evaluationIdempotencyKey(base));
    },
  );

  it('produces a 64-character hex key the schema will accept', () => {
    expect(evaluationIdempotencyKey(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('migration set', () => {
  it('is a dense, ordered sequence with stable checksums', () => {
    const first = loadMigrations();
    // Dense 1..n rather than a hardcoded list: a later milestone adds migrations,
    // and the property that must hold is the density, not the count.
    expect(first.length).toBeGreaterThanOrEqual(3);
    expect(first.map((m) => m.version)).toEqual(first.map((_, i) => i + 1));
    // Re-reading the same files must give the same checksums, or the drift check
    // would fire on an unchanged repository.
    expect(loadMigrations().map((m) => m.checksum)).toEqual(first.map((m) => m.checksum));
    for (const m of first) expect(m.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never grants UPDATE or DELETE on a fact table to the runtime role', () => {
    const grants = loadMigrations().find((m) => m.name === 'runtime_privileges');
    expect(grants).toBeDefined();
    const sql = grants!.sql;
    const appendOnlyGrant = /GRANT SELECT, INSERT ON([\s\S]*?)TO ictt_sentinel_runtime;/.exec(sql);
    expect(appendOnlyGrant).not.toBeNull();
    for (const table of [
      'chain_blocks',
      'chain_logs',
      'observations',
      'message_transitions',
      'evaluations',
      'verdict_events',
      'evidence_bundles',
    ]) {
      expect(appendOnlyGrant![1]).toContain(table);
    }
  });

  // These files name the things they forbid, in `--` comments and in the COMMENT
  // ON text stored alongside the columns. A column TYPE can appear in neither, so
  // both are removed before the type assertions run.
  const statementsOf = (sql: string) =>
    sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .replace(/'[^']*'/g, "''")
      .toLowerCase();

  it('declares no DOUBLE PRECISION column anywhere', () => {
    for (const m of loadMigrations()) {
      const statements = statementsOf(m.sql);
      expect(statements).not.toContain('double precision');
      expect(statements).not.toMatch(/\bfloat\d*\b/);
      expect(statements).not.toMatch(/\breal\b/);
    }
  });

  it('has no confirmations column, which would imply a finality depth', () => {
    // Ethereum-style confirmation depth is not Avalanche finality; the schema must
    // offer nowhere to put such a number (docs/DATA_MODEL.md 3.1).
    for (const m of loadMigrations()) {
      expect(statementsOf(m.sql)).not.toContain('confirmations');
    }
  });

  it('constrains amounts to NUMERIC(78,0), which holds uint256 exactly', () => {
    const ledger = loadMigrations().find((m) => m.name === 'raw_fact_ledger');
    expect(statementsOf(ledger!.sql)).toContain('amount          numeric(78, 0)');
  });
});
