import { describe, expect, it } from 'vitest';
import { renderTable, runLab, type Scenario } from './registry.js';
import { scanForbiddenSurface } from './surface.js';
import { rpcScenarios } from './scenarios/rpc.js';
import { accountingScenarios } from './scenarios/accounting.js';
import { lifecycleScenarios } from './scenarios/lifecycle.js';
import { protocolScenarios } from './scenarios/protocol.js';
import { operationsScenarios } from './scenarios/operations.js';

/**
 * The fault lab gate.
 *
 * One command, one corpus, five counters. The counters are the release gate the
 * milestone prompt specifies, and each is asserted separately so a failure names
 * the class of defect rather than "the lab failed".
 */

export const ALL_SCENARIOS: readonly Scenario[] = [
  ...rpcScenarios,
  ...accountingScenarios,
  ...lifecycleScenarios,
  ...protocolScenarios,
  ...operationsScenarios,
];

const surface = scanForbiddenSurface();
const result = runLab(ALL_SCENARIOS, surface.length);

describe('fault lab', () => {
  it('has a corpus with a control in every family', () => {
    // A corpus in which nothing can pass would report zero false negatives and
    // prove nothing, so the shape of the corpus is itself asserted.
    const byCorpus = new Map<string, number>();
    for (const s of ALL_SCENARIOS) byCorpus.set(s.corpus, (byCorpus.get(s.corpus) ?? 0) + 1);
    expect(ALL_SCENARIOS.length).toBeGreaterThanOrEqual(50);
    for (const corpus of ['deterministic-breach', 'gap', 'rpc', 'fingerprint', 'unsupported']) {
      expect(byCorpus.get(corpus) ?? 0, `${corpus} corpus is empty`).toBeGreaterThan(0);
    }
    // At least one scenario must be able to reach OK, or "no false OK" is vacuous.
    const green = result.rows.filter((r) => r.observed?.protocolStatus === 'OK');
    expect(green.length).toBeGreaterThan(0);
    // Every scenario id is unique and every one carries provenance.
    expect(new Set(ALL_SCENARIOS.map((s) => s.id)).size).toBe(ALL_SCENARIOS.length);
    for (const s of ALL_SCENARIOS) {
      expect(s.provenance.length, `${s.id} has no provenance`).toBeGreaterThan(10);
      expect(Object.keys(s.pinned).length, `${s.id} pins no inputs`).toBeGreaterThan(0);
      expect(
        Object.values(s.fixed).every((value) => value.length > 0),
        `${s.id} has an incomplete fixed fixture`,
      ).toBe(true);
      expect(s.expect.digest.length, `${s.id} has no digest rule`).toBeGreaterThan(0);
    }
  });

  it('counter 1: no false negative in the required deterministic breach corpus', () => {
    const breaches = ALL_SCENARIOS.filter((s) => s.corpus === 'deterministic-breach');
    expect(breaches.length).toBeGreaterThanOrEqual(6);
    expect(result.counters.falseNegatives, renderTable(result)).toBe(0);
  });

  it('counter 2: no false OK in the gap, RPC, fingerprint and unsupported corpora', () => {
    expect(result.counters.falseOks, renderTable(result)).toBe(0);
  });

  it('counter 3: no digest or verdict drift for the same pinned input', () => {
    expect(result.counters.digestDrift, renderTable(result)).toBe(0);
  });

  it('counter 4: no signing, chain-write or auto-pause surface anywhere', () => {
    expect(
      result.counters.forbiddenSurfaces,
      surface.map((f) => `${f.file}: ${f.what}`).join('\n'),
    ).toBe(0);
  });

  it('counter 5: no secret canary reaches any outbound surface', () => {
    const canary = result.rows.find((r) => r.scenario.id === 'evidence/secret-canary-never-leaves');
    expect(canary, 'the canary scenario is missing from the corpus').toBeDefined();
    expect(
      result.counters.secretCanaryLeaks,
      canary?.findings.map((f) => f.detail).join('\n'),
    ).toBe(0);
  });

  it('every scenario meets its declared expectation', () => {
    const failures = result.findings.map((f) => `${f.scenarioId} ${f.kind}: ${f.detail}`);
    expect(failures, renderTable(result)).toEqual([]);
  });
});
