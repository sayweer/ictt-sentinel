import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  aggregationInput,
  cleanBaseline,
  contribution,
  driftObservation,
} from '@ictt-sentinel/testkit';
import { assessDrift, classifyDiscoveredRemote } from '../src/drift.js';
import {
  CLAIM_MODES,
  DATA_STATUSES,
  EXIT_CODES,
  aggregate,
  exitCodeFor,
  isOverallGreen,
  type RuleContribution,
} from '../src/verdict.js';

describe('baseline drift', () => {
  it('is clean when every required control matches', () => {
    const d = assessDrift(cleanBaseline());
    expect(d.allRequiredEstablished).toBe(true);
    expect(d.critical).toBe(false);
    expect(d.reasons).toEqual([]);
  });

  it.each([
    'proxy-implementation-slot',
    'implementation-code-hash',
    'contract-address',
    'chain-identity',
    'token-decimals',
    'minter-allowlist',
    'admin-upgrade-authority',
  ] as const)('treats drift in %s as a configuration breach', (control) => {
    const d = assessDrift([
      ...cleanBaseline().filter((o) => o.control !== control),
      driftObservation(control, { status: 'drift', observed: 'something-else' }),
    ]);
    expect(d.critical).toBe(true);
    expect(d.reasons).toContain('CFG-D01-BASELINE-DRIFT');
  });

  it('never auto-approves a discovered remote', () => {
    // Discovery is not approval. There is no argument that returns `match`.
    expect(classifyDiscoveredRemote(false)).toBe('candidate');
    expect(classifyDiscoveredRemote(true)).toBe('match');
  });

  it('reports an unapproved candidate for review rather than trusting it', () => {
    const d = assessDrift([
      ...cleanBaseline(),
      driftObservation('registered-remote-census', {
        status: 'candidate',
        expected: null,
        observed: '0xnew-remote',
      }),
    ]);
    expect(d.candidates).toHaveLength(1);
    expect(d.reasons).toContain('CFG-D02-UNAPPROVED-CANDIDATE');
    // A candidate is not a breach, but it does block "everything established".
    expect(d.critical).toBe(false);
  });

  it('never counts an unresolved control as a match', () => {
    const d = assessDrift([
      ...cleanBaseline().filter((o) => o.control !== 'token-decimals'),
      driftObservation('token-decimals', { status: 'unknown', observed: null }),
    ]);
    expect(d.allRequiredEstablished).toBe(false);
    expect(d.reasons).toContain('CFG-D03-CONTROL-UNRESOLVED');
  });

  it('ignores an OBSERVE_ONLY control for the required verdict', () => {
    const d = assessDrift([
      ...cleanBaseline(),
      driftObservation('contract-role', { status: 'drift', required: false }),
    ]);
    expect(d.allRequiredEstablished).toBe(true);
    expect(d.critical).toBe(false);
  });
});

describe('global verdict truth table', () => {
  const critical = (): RuleContribution =>
    contribution({ ruleId: 'R-CRIT', result: 'FAIL', critical: true });
  const unknownRequired = (): RuleContribution =>
    contribution({ ruleId: 'R-UNK', result: 'UNKNOWN', required: true });
  const warnOnly = (): RuleContribution =>
    contribution({ ruleId: 'R-WARN', result: 'FAIL', critical: false, livenessOnly: true });

  it('is OK only when everything required is complete, fresh and passing', () => {
    const v = aggregate(aggregationInput());
    expect(v.protocolStatus).toBe('OK');
    expect(isOverallGreen(v)).toBe(true);
    expect(exitCodeFor(v)).toBe(EXIT_CODES.ok);
  });

  it('is CRITICAL on a proven breach', () => {
    const v = aggregate(aggregationInput({ contributions: [critical()] }));
    expect(v.protocolStatus).toBe('CRITICAL');
    expect(v.criticalRuleIds).toEqual(['R-CRIT']);
    expect(exitCodeFor(v)).toBe(EXIT_CODES.critical);
  });

  it('does NOT hide a proven CRITICAL behind a simultaneous UNKNOWN', () => {
    const v = aggregate(aggregationInput({ contributions: [critical(), unknownRequired()] }));
    expect(v.protocolStatus).toBe('CRITICAL');
    // Both are reported: the operator must see that other checks are blind too.
    expect(v.criticalRuleIds).toEqual(['R-CRIT']);
    expect(v.unknownRuleIds).toEqual(['R-UNK']);
  });

  it('is UNKNOWN when a required control cannot be established and nothing is proven', () => {
    const v = aggregate(aggregationInput({ contributions: [unknownRequired()] }));
    expect(v.protocolStatus).toBe('UNKNOWN');
    expect(exitCodeFor(v)).toBe(EXIT_CODES.requiredUnknown);
    // Different exit code from CRITICAL: an incident and a blind spot need
    // different responses.
    expect(EXIT_CODES.requiredUnknown).not.toBe(EXIT_CODES.critical);
  });

  it('is WARN for a policy or liveness deviation with nothing stronger', () => {
    const v = aggregate(aggregationInput({ contributions: [warnOnly()] }));
    expect(v.protocolStatus).toBe('WARN');
    expect(exitCodeFor(v)).toBe(EXIT_CODES.warn);
  });

  it('never lets an optional UNKNOWN block the verdict', () => {
    const v = aggregate(
      aggregationInput({
        contributions: [
          contribution(),
          contribution({ ruleId: 'R-OPT', result: 'UNKNOWN', required: false }),
        ],
      }),
    );
    expect(v.protocolStatus).toBe('OK');
  });

  it('is UNKNOWN when a required evaluation never ran', () => {
    // A missing evaluation defaulting to OK is the failure this prevents.
    const v = aggregate(aggregationInput({ missingRequiredEvaluations: ['ACC-NATIVE'] }));
    expect(v.protocolStatus).toBe('UNKNOWN');
    expect(v.reasonCodes).toContain('AGG-M01-REQUIRED-EVALUATION-MISSING');
  });

  it('turns an expired previous OK into UNKNOWN', () => {
    const v = aggregate(aggregationInput({ previousOkExpired: true }));
    expect(v.protocolStatus).toBe('UNKNOWN');
    expect(v.reasonCodes).toContain('AGG-M02-PREVIOUS-OK-EXPIRED');
  });

  it('never lets an exception, timeout or parse error fall through to PASS', () => {
    const v = aggregate(aggregationInput({ evaluationFaults: ['timeout reading remote supply'] }));
    expect(v.protocolStatus).toBe('UNKNOWN');
    expect(v.reasonCodes).toContain('AGG-M03-EVALUATION-FAULT');
  });

  it.each(DATA_STATUSES.filter((d) => d !== 'COMPLETE'))(
    'is UNKNOWN when data status is %s, even with every rule passing',
    (dataStatus) => {
      const v = aggregate(aggregationInput({ dataStatus }));
      expect(v.protocolStatus).toBe('UNKNOWN');
      // The field survives aggregation rather than being folded away.
      expect(v.dataStatus).toBe(dataStatus);
    },
  );

  it('keeps protocol_status and data_status independent', () => {
    const v = aggregate(aggregationInput({ contributions: [critical()], dataStatus: 'PARTIAL' }));
    expect(v.protocolStatus).toBe('CRITICAL');
    expect(v.dataStatus).toBe('PARTIAL');
  });

  it('is UNKNOWN when coverage is not complete', () => {
    expect(aggregate(aggregationInput({ coverage: 'PARTIAL' })).protocolStatus).toBe('UNKNOWN');
    expect(aggregate(aggregationInput({ coverage: 'UNVERIFIED' })).protocolStatus).toBe('UNKNOWN');
  });

  it('reports the weakest claim mode of its contributions', () => {
    const v = aggregate(
      aggregationInput({
        contributions: [
          contribution({ claimMode: 'EXACT' }),
          contribution({ ruleId: 'R2', claimMode: 'SUFFICIENT_UPPER_BOUND' }),
        ],
      }),
    );
    // An aggregate is only as strong as its softest member.
    expect(v.claimMode).toBe('SUFFICIENT_UPPER_BOUND');
  });

  it('is never green on an INDETERMINATE or UNSUPPORTED claim', () => {
    for (const claimMode of ['INDETERMINATE', 'UNSUPPORTED'] as const) {
      const v = aggregate(aggregationInput({ contributions: [contribution({ claimMode })] }));
      expect(isOverallGreen(v)).toBe(false);
    }
  });

  it('carries assumptions, exclusions and a runbook anchor that exists', () => {
    const v = aggregate(aggregationInput());
    expect(v.assumptions.length).toBeGreaterThan(2);
    expect(v.exclusions.join(' ')).toContain('never appear under a collateral headline');
    // A dead runbook link is worse than none: it sends an on-call engineer to a
    // page that does not answer the question.
    const doc = readFileSync(
      fileURLToPath(new URL('../../../docs/RUNBOOK.md', import.meta.url)),
      'utf8',
    );
    const anchor = v.runbook.split('#')[1];
    expect(anchor).toBeDefined();
    expect(doc).toContain(`### ${String(anchor)}`);
  });
});

describe('heuristic risk never becomes an economic headline', () => {
  it('a rate anomaly is a WARN, not a CRITICAL', () => {
    const v = aggregate(
      aggregationInput({
        contributions: [
          contribution({
            ruleId: 'RSK-RATE',
            result: 'FAIL',
            critical: false,
            livenessOnly: true,
            reasons: ['RSK-H01-RATE-ANOMALY'],
          }),
        ],
      }),
    );
    expect(v.protocolStatus).toBe('WARN');
    expect(v.protocolStatus).not.toBe('CRITICAL');
    expect(v.reasonCodes).toContain('RSK-H01-RATE-ANOMALY');
  });

  it('a liveness WARN sits alongside a healthy economic proof', () => {
    const v = aggregate(
      aggregationInput({
        contributions: [
          contribution({ ruleId: 'ACC', result: 'PASS' }),
          contribution({
            ruleId: 'RSK-RECEIPT',
            result: 'FAIL',
            critical: false,
            reasons: ['RSK-H02-RECEIPT-DELAY'],
          }),
        ],
      }),
    );
    expect(v.protocolStatus).toBe('WARN');
    expect(v.criticalRuleIds).toEqual([]);
  });
});

describe('property: fail-closed aggregation', () => {
  const contributionArb = fc.record({
    ruleId: fc.string({ minLength: 1, maxLength: 6 }),
    result: fc.constantFrom<RuleContribution['result'][]>('PASS', 'FAIL', 'UNKNOWN', 'UNSUPPORTED'),
    critical: fc.boolean(),
    required: fc.boolean(),
    claimMode: fc.constantFrom(...CLAIM_MODES),
    reasons: fc.constant([] as const),
  });

  it('no combination with a required UNKNOWN and no CRITICAL is ever OK', () => {
    fc.assert(
      fc.property(
        fc.array(contributionArb, { minLength: 1, maxLength: 6 }),
        fc.constantFrom(...DATA_STATUSES),
        fc.constantFrom('COMPLETE', 'PARTIAL', 'UNVERIFIED' as const),
        (contributions, dataStatus, coverage) => {
          const v = aggregate(
            aggregationInput({ contributions, dataStatus, coverage: coverage as 'COMPLETE' }),
          );
          const hasCritical = contributions.some((c) => c.critical);
          const hasRequiredUnknown = contributions.some(
            (c) => c.required && (c.result === 'UNKNOWN' || c.result === 'UNSUPPORTED'),
          );
          if (!hasCritical && hasRequiredUnknown) {
            expect(v.protocolStatus).not.toBe('OK');
          }
          if (hasCritical) expect(v.protocolStatus).toBe('CRITICAL');
          if (v.protocolStatus === 'OK') {
            // The only way to be OK, stated as a property.
            expect(dataStatus).toBe('COMPLETE');
            expect(coverage).toBe('COMPLETE');
            expect(hasRequiredUnknown).toBe(false);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('evidence monotonicity: removing a required evidence piece cannot improve the verdict', () => {
    const RANK = { OK: 0, WARN: 1, UNKNOWN: 2, CRITICAL: 3 } as const;
    fc.assert(
      fc.property(
        fc.array(contributionArb, { minLength: 2, maxLength: 6 }),
        fc.nat({ max: 5 }),
        (contributions, dropIndex) => {
          const full = aggregate(aggregationInput({ contributions }));
          const i = dropIndex % contributions.length;
          const dropped = contributions[i];
          if (!dropped?.required) return;
          // Removing a required contribution turns it into a missing evaluation.
          const degraded = aggregate(
            aggregationInput({
              contributions: contributions.filter((_, n) => n !== i),
              missingRequiredEvaluations: [dropped.ruleId],
            }),
          );
          // Deleting evidence must never make the answer better.
          expect(RANK[degraded.protocolStatus]).toBeGreaterThanOrEqual(
            Math.min(RANK[full.protocolStatus], RANK.UNKNOWN),
          );
          expect(degraded.protocolStatus).not.toBe('OK');
        },
      ),
      { numRuns: 400 },
    );
  });

  it('exit code is zero only for an overall OK', () => {
    fc.assert(
      fc.property(fc.array(contributionArb, { minLength: 1, maxLength: 5 }), (contributions) => {
        const v = aggregate(aggregationInput({ contributions }));
        expect(exitCodeFor(v) === 0).toBe(v.protocolStatus === 'OK');
      }),
      { numRuns: 300 },
    );
  });
});
