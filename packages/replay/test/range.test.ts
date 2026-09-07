import { describe, expect, it } from 'vitest';
import { classifyObservation, findRangeGaps, rangeDigest } from '../src/range.js';
import { block, hex32, log, observation } from './fixtures.js';

describe('rangeDigest', () => {
  it('is independent of log and block arrival order', () => {
    const base = observation();
    const shuffled = observation({
      logs: [...base.logs].reverse(),
      blocks: [...base.blocks].reverse(),
    });
    expect(rangeDigest(shuffled)).toBe(rangeDigest(base));
  });

  it('differs when the same heights carry different block hashes', () => {
    // Height is not identity after a reorg: two providers returning "block 10"
    // with different hashes must NOT be treated as agreeing.
    const a = observation();
    const b = observation({
      blocks: [block(10, { blockHash: hex32(9_999) }), block(11)],
      startBlockHash: hex32(9_999),
    });
    expect(rangeDigest(b)).not.toBe(rangeDigest(a));
  });

  it('differs when a single log is missing', () => {
    const base = observation();
    const short = observation({ logs: base.logs.slice(0, 2) });
    expect(rangeDigest(short)).not.toBe(rangeDigest(base));
  });

  it('differs when the range bounds differ', () => {
    expect(rangeDigest(observation({ to: 12, blocks: [block(10), block(12)] }))).not.toBe(
      rangeDigest(observation()),
    );
  });
});

describe('classifyObservation', () => {
  it('accepts a complete, well-formed observation', () => {
    const outcome = classifyObservation(observation());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.logCount).toBe(3);
      expect(outcome.result.digest).toMatch(/^[0-9a-f]{64}$/);
      // The facts travel with the result so an agreed range can be persisted.
      expect(outcome.result.blocks).toHaveLength(2);
    }
  });

  it('detects silent truncation from a count that does not match the body', () => {
    const outcome = classifyObservation(observation({ logCount: 5 }));
    expect(outcome).toMatchObject({ ok: false, reason: 'SILENT_TRUNCATION' });
  });

  it('refuses to read an incomplete empty answer as "no logs here"', () => {
    const outcome = classifyObservation(observation({ logs: [], logCount: 0, complete: false }));
    expect(outcome).toMatchObject({ ok: false, reason: 'EMPTY_RESPONSE_AMBIGUITY' });
  });

  it('treats an incomplete non-empty answer as truncation', () => {
    const outcome = classifyObservation(observation({ complete: false }));
    expect(outcome).toMatchObject({ ok: false, reason: 'SILENT_TRUNCATION' });
  });

  it('detects a hole in a block log index sequence', () => {
    const outcome = classifyObservation(
      observation({ logs: [log(10, 0, 0), log(10, 0, 2), log(11, 0, 0)] }),
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'MISSING_LOG' });
  });

  it('detects a log whose block is absent from the observation', () => {
    const outcome = classifyObservation(
      observation({ blocks: [block(10)], logs: [log(10, 0, 0), log(11, 0, 0)] }),
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'MISSING_BLOCK' });
  });

  it('rejects a candidate block on the canonical truth path', () => {
    // A speed-path observation must never become history.
    const outcome = classifyObservation(
      observation({
        blocks: [block(10), block(11, { observedClass: 'candidate' })],
      }),
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'NONCANONICAL_BLOCK_REJECTED' });
  });

  it('allows an empty range only when the provider positively covered it', () => {
    const outcome = classifyObservation(
      observation({ blocks: [block(10), block(11)], logs: [], logCount: 0, complete: true }),
    );
    expect(outcome.ok).toBe(true);
  });
});

describe('findRangeGaps', () => {
  const window = { fromBlock: 100n, toBlock: 199n };

  it('reports no gap for full coverage', () => {
    expect(
      findRangeGaps(
        [
          { fromBlock: 100n, toBlock: 149n },
          { fromBlock: 150n, toBlock: 199n },
        ],
        window,
      ),
    ).toEqual([]);
  });

  it('finds a hole in the middle', () => {
    expect(
      findRangeGaps(
        [
          { fromBlock: 100n, toBlock: 120n },
          { fromBlock: 131n, toBlock: 199n },
        ],
        window,
      ),
    ).toEqual([{ fromBlock: 121n, toBlock: 130n }]);
  });

  it('finds a missing tail', () => {
    expect(findRangeGaps([{ fromBlock: 100n, toBlock: 150n }], window)).toEqual([
      { fromBlock: 151n, toBlock: 199n },
    ]);
  });

  it('reports the whole window when nothing is covered', () => {
    expect(findRangeGaps([], window)).toEqual([window]);
  });

  it('is order-insensitive', () => {
    const covered = [
      { fromBlock: 150n, toBlock: 199n },
      { fromBlock: 100n, toBlock: 149n },
    ];
    expect(findRangeGaps(covered, window)).toEqual([]);
  });
});
