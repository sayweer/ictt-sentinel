import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REASON_METADATA, REPLAY_REASONS, isRetryable } from '../src/reasons.js';

const RUNBOOK = readFileSync(
  fileURLToPath(new URL('../../../docs/RUNBOOK.md', import.meta.url)),
  'utf8',
);

describe('reason metadata', () => {
  it('covers every reason exactly once', () => {
    expect(Object.keys(REASON_METADATA).sort()).toEqual([...REPLAY_REASONS].sort());
  });

  it('points every reason at a runbook anchor that actually exists', () => {
    // A dead runbook link is worse than none: it sends an on-call engineer to a
    // page that does not answer the question.
    for (const reason of REPLAY_REASONS) {
      const { runbook } = REASON_METADATA[reason];
      const anchor = runbook.split('#')[1];
      expect(anchor, `${reason} has no anchor`).toBeDefined();
      expect(RUNBOOK, `${reason} -> ${runbook}`).toContain(`### ${anchor!}`);
    }
  });

  it('never describes a coverage gap in economic language', () => {
    // A missing range is not evidence of a collateral problem. Reporting one as
    // the other is the failure docs/INVARIANTS.md 1 forbids.
    const forbidden = [
      'undercollateral',
      'insolvent',
      'solvent',
      'proof of reserves',
      'guaranteed',
      'tamper-proof',
    ];
    for (const reason of REPLAY_REASONS) {
      const text = REASON_METADATA[reason].summary.toLowerCase();
      for (const word of forbidden) expect(text).not.toContain(word);
    }
  });

  it('marks structural failures as non-retryable', () => {
    // Neither another attempt nor a narrower range can add a provider group,
    // un-prune history, or declare an archive witness.
    expect(isRetryable('INSUFFICIENT_WITNESSES')).toBe(false);
    expect(isRetryable('PRUNED_HISTORY')).toBe(false);
    expect(isRetryable('PROVIDER_DIVERGENCE')).toBe(false);
    expect(isRetryable('ARCHIVE_FALLBACK_UNAVAILABLE')).toBe(false);
    expect(isRetryable('NONCANONICAL_BLOCK_REJECTED')).toBe(false);
    expect(isRetryable('RANGE_INDIVISIBLE')).toBe(false);
    expect(isRetryable('RETRY_BUDGET_EXHAUSTED')).toBe(false);
  });

  it('marks transient transport failures as retryable', () => {
    expect(isRetryable('SILENT_TRUNCATION')).toBe(true);
    expect(isRetryable('MISSING_BLOCK')).toBe(true);
    expect(isRetryable('MISSING_LOG')).toBe(true);
    expect(isRetryable('EMPTY_RESPONSE_AMBIGUITY')).toBe(true);
  });

  it('gives every reason a non-empty summary and runbook', () => {
    for (const reason of REPLAY_REASONS) {
      const meta = REASON_METADATA[reason];
      expect(meta.summary.length).toBeGreaterThan(10);
      expect(meta.runbook).toMatch(/^docs\/RUNBOOK\.md#[a-z-]+$/);
    }
  });
});
