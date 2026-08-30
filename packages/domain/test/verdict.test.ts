import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  PROOF_CLASSES,
  SUPPLY_ASSESSMENTS,
  VERDICTS,
  combineVerdicts,
  isHealthy,
  supplyAssessmentToVerdict,
} from '../src/verdict.js';
import type { Judgement, Verdict } from '../src/verdict.js';

const required = (verdict: Verdict): Judgement => ({ verdict, requirement: 'required' });
const optional = (verdict: Verdict): Judgement => ({ verdict, requirement: 'optional' });

describe('verdict enum', () => {
  it('is exhaustive and stable', () => {
    expect([...VERDICTS]).toEqual(['OK', 'WARN', 'UNKNOWN', 'CRITICAL']);
  });

  it('exposes the four proof classes', () => {
    expect([...PROOF_CLASSES]).toEqual(['coverage', 'correctness', 'liveness', 'heuristic']);
  });

  it('handles every verdict in a switch without a default branch', () => {
    const describeVerdict = (v: Verdict): string => {
      switch (v) {
        case 'OK':
          return 'ok';
        case 'WARN':
          return 'warn';
        case 'UNKNOWN':
          return 'unknown';
        case 'CRITICAL':
          return 'critical';
      }
    };
    for (const v of VERDICTS) expect(describeVerdict(v)).toBe(v.toLowerCase());
  });
});

describe('lattice: CRITICAL > required UNKNOWN > WARN > OK', () => {
  it('CRITICAL dominates everything', () => {
    for (const v of VERDICTS) {
      expect(combineVerdicts([required('CRITICAL'), required(v)])).toBe('CRITICAL');
    }
  });

  it('a required UNKNOWN outranks WARN', () => {
    expect(combineVerdicts([required('UNKNOWN'), required('WARN')])).toBe('UNKNOWN');
  });

  it('an optional UNKNOWN does not outrank WARN', () => {
    expect(combineVerdicts([optional('UNKNOWN'), required('WARN')])).toBe('WARN');
  });

  it('WARN outranks OK', () => {
    expect(combineVerdicts([required('WARN'), required('OK')])).toBe('WARN');
  });

  it('all-OK stays OK', () => {
    expect(combineVerdicts([required('OK'), optional('OK')])).toBe('OK');
  });
});

describe('UNKNOWN is never green', () => {
  it('an empty evidence set is UNKNOWN, not OK', () => {
    expect(combineVerdicts([])).toBe('UNKNOWN');
  });

  it('a required UNKNOWN can never combine down to OK', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...VERDICTS), { maxLength: 8 }), (others) => {
        const judgements = [required('UNKNOWN'), ...others.map(optional)];
        expect(combineVerdicts(judgements)).not.toBe('OK');
      }),
      { numRuns: 300 },
    );
  });

  it('only OK is reported as healthy', () => {
    expect(isHealthy('OK')).toBe(true);
    for (const v of VERDICTS.filter((x) => x !== 'OK')) {
      expect(isHealthy(v)).toBe(false);
    }
  });

  it('the combined verdict is healthy only when every judgement is OK', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            verdict: fc.constantFrom(...VERDICTS),
            requirement: fc.constantFrom('required', 'optional'),
          }),
          {
            minLength: 1,
            maxLength: 8,
          },
        ),
        (js) => {
          const combined = combineVerdicts(js);
          if (isHealthy(combined)) {
            expect(js.every((j) => j.verdict === 'OK')).toBe(true);
          }
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe('native supply assessment', () => {
  it('offers exactly sufficient, indeterminate and unknown', () => {
    expect([...SUPPLY_ASSESSMENTS]).toEqual(['sufficient', 'indeterminate', 'unknown']);
  });

  it('never maps indeterminate or unknown to a healthy verdict', () => {
    expect(supplyAssessmentToVerdict('sufficient')).toBe('OK');
    expect(isHealthy(supplyAssessmentToVerdict('indeterminate'))).toBe(false);
    expect(isHealthy(supplyAssessmentToVerdict('unknown'))).toBe(false);
  });

  it('maps every assessment exhaustively', () => {
    for (const a of SUPPLY_ASSESSMENTS) {
      expect(VERDICTS).toContain(supplyAssessmentToVerdict(a));
    }
  });
});
