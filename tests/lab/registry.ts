import type { DataStatus, ProtocolStatus } from '@ictt-sentinel/invariant-core';

/**
 * The deterministic fault lab.
 *
 * Every scenario is a hostile or degraded condition this product claims to
 * handle, expressed as data plus a function that drives the REAL engines. There
 * are no mocks of the thing under test: a scenario that stubbed the invariant
 * core would prove that the stub agrees with itself.
 *
 * Each scenario carries what the prompt requires of a fixture - provenance,
 * pinned inputs, and the expected protocol status, data status, reason codes,
 * CLI exit code and digest rule - so a reader can check the expectation against
 * the source-locked document rather than against the implementation.
 *
 * The corpus a scenario belongs to decides which counter it feeds. That
 * classification is the whole point: a missed breach and a wrongly green gap are
 * different failures with different consequences.
 */

export const CORPORA = [
  /** A breach the evidence proves. Anything but CRITICAL is a FALSE NEGATIVE. */
  'deterministic-breach',
  /** History could not be read completely. Must never be OK. */
  'gap',
  /** The providers themselves are the problem. Must never be OK. */
  'rpc',
  /** The deployed code is not what was approved, or is unreadable. Never OK. */
  'fingerprint',
  /** A shape this build does not interpret. Never OK, never a guess. */
  'unsupported',
  /** A boundary that must hold. Produces no verdict; asserts a property. */
  'operational',
] as const;
export type Corpus = (typeof CORPORA)[number];

/** Corpora in which a green protocol status is, by definition, a false OK. */
export const NEVER_OK: readonly Corpus[] = ['gap', 'rpc', 'fingerprint', 'unsupported'];

export interface Expectation {
  /** null means the fixture exercises a pre-verdict boundary. */
  readonly protocolStatus: ProtocolStatus | null;
  readonly dataStatus: DataStatus | null;
  /** Every code listed must appear. Extra codes are allowed. */
  readonly reasonCodes: readonly string[];
  readonly exitCode: number | null;
  /**
   * `stable` means: the same pinned input must produce the same digest on every
   * run. A literal string pins an exact digest.
   */
  readonly digest: string;
  /** Named properties the scenario asserts about itself. */
  readonly holds: readonly string[];
}

export interface Observed {
  readonly protocolStatus?: ProtocolStatus;
  readonly dataStatus?: DataStatus;
  readonly reasonCodes?: readonly string[];
  readonly exitCode?: number;
  readonly digest?: string;
  readonly holds?: readonly string[];
}

export interface Scenario {
  readonly id: string;
  readonly title: string;
  readonly corpus: Corpus;
  /**
   * Where the expectation comes from. A document section, a source-locked
   * contract, or an ADR - never "because the code does this".
   */
  readonly provenance: string;
  /** Fixed chain, block, hash, time and amount inputs. No clock, no randomness. */
  readonly pinned: Readonly<Record<string, string>>;
  readonly fixed: {
    readonly chain: string;
    readonly blockNumber: string;
    readonly blockHash: string;
    readonly observedAt: string;
    readonly amount: string;
  };
  readonly expect: Expectation;
  run: () => Observed | Promise<Observed>;
}

export type ScenarioInput = Omit<Scenario, 'fixed' | 'expect'> & {
  readonly fixed?: Partial<Scenario['fixed']>;
  readonly expect: Partial<Expectation>;
};

const FIXTURE_DEFAULTS: Scenario['fixed'] = {
  chain: 'avalanche-c-chain-fixture',
  blockNumber: '1000',
  blockHash: `0x${'11'.repeat(32)}`,
  observedAt: '2026-06-01T00:00:00.000Z',
  amount: '0',
};

/** Materialise every fixture field so the corpus is portable and auditable. */
export const defineScenarios = (inputs: readonly ScenarioInput[]): readonly Scenario[] =>
  inputs.map((input) => ({
    ...input,
    fixed: {
      ...FIXTURE_DEFAULTS,
      blockNumber: input.pinned.blockNumber ?? input.pinned.height ?? FIXTURE_DEFAULTS.blockNumber,
      blockHash: input.pinned.blockHash ?? input.pinned.hashA ?? FIXTURE_DEFAULTS.blockHash,
      amount:
        input.pinned.amount ??
        input.pinned.transferredBalance ??
        input.pinned.U ??
        FIXTURE_DEFAULTS.amount,
      ...input.fixed,
    },
    expect: {
      protocolStatus: null,
      dataStatus: null,
      reasonCodes: [],
      exitCode: null,
      digest: 'stable-observed-output',
      holds: [],
      ...input.expect,
    },
  }));

export interface Finding {
  readonly scenarioId: string;
  readonly kind:
    | 'false-negative'
    | 'false-ok'
    | 'digest-drift'
    | 'wrong-protocol-status'
    | 'wrong-data-status'
    | 'missing-reason-code'
    | 'wrong-exit-code'
    | 'property-not-held'
    | 'threw';
  readonly detail: string;
}

export interface LabRow {
  readonly scenario: Scenario;
  readonly observed: Observed | null;
  readonly findings: readonly Finding[];
}

export interface LabResult {
  readonly rows: readonly LabRow[];
  readonly counters: {
    /** Required deterministic breach corpus: a breach that was not called. */
    readonly falseNegatives: number;
    /** Gap / RPC / fingerprint / unsupported corpora: anything reported green. */
    readonly falseOks: number;
    /** Same pinned input, different digest or verdict across two runs. */
    readonly digestDrift: number;
    /** Static forbidden surface findings. */
    readonly forbiddenSurfaces: number;
    /** Canary scenario missing or failing its outbound checks. */
    readonly secretCanaryLeaks: number;
  };
  readonly findings: readonly Finding[];
}

const missing = (expected: readonly string[], actual: readonly string[]): readonly string[] =>
  expected.filter((code) => !actual.includes(code));

/**
 * Run one scenario twice.
 *
 * Twice, always: determinism is not a property you can check by running once,
 * and a verdict that moves between two invocations of the same pinned input is
 * a defect whatever its value.
 */
const evaluate = async (scenario: Scenario): Promise<LabRow> => {
  const findings: Finding[] = [];
  let first: Observed;
  let second: Observed;
  try {
    first = await scenario.run();
    second = await scenario.run();
  } catch (e) {
    return {
      scenario,
      observed: null,
      findings: [
        {
          scenarioId: scenario.id,
          kind: 'threw',
          detail: e instanceof Error ? e.message : 'scenario threw a non-Error',
        },
      ],
    };
  }

  if (JSON.stringify(first) !== JSON.stringify(second)) {
    findings.push({
      scenarioId: scenario.id,
      kind: 'digest-drift',
      detail: 'two runs of the same pinned input did not agree',
    });
  }

  const { expect: want } = scenario;
  if (scenario.corpus === 'deterministic-breach' && first.protocolStatus !== 'CRITICAL') {
    findings.push({
      scenarioId: scenario.id,
      kind: 'false-negative',
      detail: `deterministic breach observed ${first.protocolStatus ?? 'no protocol status'}`,
    });
  }
  if (want.protocolStatus !== null && first.protocolStatus !== want.protocolStatus) {
    findings.push({
      scenarioId: scenario.id,
      kind: 'wrong-protocol-status',
      detail: `expected ${want.protocolStatus}, observed ${first.protocolStatus ?? 'nothing'}`,
    });
  }
  if (want.dataStatus !== null && first.dataStatus !== want.dataStatus) {
    findings.push({
      scenarioId: scenario.id,
      kind: 'wrong-data-status',
      detail: `expected ${want.dataStatus}, observed ${first.dataStatus ?? 'nothing'}`,
    });
  }
  const absent = missing(want.reasonCodes, first.reasonCodes ?? []);
  if (absent.length > 0) {
    findings.push({
      scenarioId: scenario.id,
      kind: 'missing-reason-code',
      detail: `expected ${absent.join(', ')}`,
    });
  }
  if (want.exitCode !== null && first.exitCode !== want.exitCode) {
    findings.push({
      scenarioId: scenario.id,
      kind: 'wrong-exit-code',
      detail: `expected ${String(want.exitCode)}, observed ${String(first.exitCode ?? -1)}`,
    });
  }
  if (!want.digest.startsWith('stable') && first.digest !== want.digest) {
    findings.push({
      scenarioId: scenario.id,
      kind: 'digest-drift',
      detail: `expected digest ${want.digest}, observed ${first.digest ?? 'none'}`,
    });
  }
  const notHeld = missing(want.holds, first.holds ?? []);
  if (notHeld.length > 0) {
    findings.push({
      scenarioId: scenario.id,
      kind: 'property-not-held',
      detail: notHeld.join(', '),
    });
  }

  // The corpus-level rule, applied regardless of what the scenario expected:
  // nothing in these corpora may come out green, even if a future edit changed
  // the per-scenario expectation to say it could.
  if (NEVER_OK.includes(scenario.corpus) && first.protocolStatus === 'OK') {
    findings.push({
      scenarioId: scenario.id,
      kind: 'false-ok',
      detail: `${scenario.corpus} scenario reported OK`,
    });
  }

  return { scenario, observed: first, findings };
};

export const runLab = async (
  scenarios: readonly Scenario[],
  forbiddenSurfaceCount = 0,
): Promise<LabResult> => {
  const rows = await Promise.all(scenarios.map(evaluate));
  const findings = rows.flatMap((r) => r.findings);
  const canary = rows.find((row) => row.scenario.id === 'evidence/secret-canary-never-leaves');
  return {
    rows,
    findings,
    counters: {
      falseNegatives: findings.filter((f) => f.kind === 'false-negative').length,
      falseOks: findings.filter((f) => f.kind === 'false-ok').length,
      digestDrift: findings.filter((f) => f.kind === 'digest-drift').length,
      forbiddenSurfaces: forbiddenSurfaceCount,
      secretCanaryLeaks: canary === undefined || canary.findings.length > 0 ? 1 : 0,
    },
  };
};

/** One line per scenario, for the milestone report and the console output. */
export const renderTable = (result: LabResult): string => {
  const header = `${'id'.padEnd(38)} ${'corpus'.padEnd(21)} ${'protocol'.padEnd(9)} ${'data'.padEnd(10)} exit  result`;
  const lines = result.rows.map((row) => {
    const o = row.observed;
    const verdict = row.findings.length === 0 ? 'pass' : row.findings.map((f) => f.kind).join(',');
    return `${row.scenario.id.padEnd(38)} ${row.scenario.corpus.padEnd(21)} ${(o?.protocolStatus ?? '-').padEnd(9)} ${(o?.dataStatus ?? '-').padEnd(10)} ${String(o?.exitCode ?? '-').padEnd(5)} ${verdict}`;
  });
  return [header, ...lines].join('\n');
};
