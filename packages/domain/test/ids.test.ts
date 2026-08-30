import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  parseBlockHash,
  parseBlockNumber,
  parseBlockchainId,
  parseEvmAddress,
  parseEvmChainId,
  parseGenesisHash,
  parseLogIndex,
  parseMessageId,
  parseProviderGroupId,
  parseTransactionHash,
} from '../src/ids.js';

const hex = (n: number, fill = 'a') => `0x${fill.repeat(n)}`;

describe('32-byte hex identifiers', () => {
  const parsers = {
    BlockchainId: parseBlockchainId,
    GenesisHash: parseGenesisHash,
    BlockHash: parseBlockHash,
    TransactionHash: parseTransactionHash,
    MessageId: parseMessageId,
  };

  for (const [label, parse] of Object.entries(parsers)) {
    describe(label, () => {
      it('accepts a canonical 32-byte hex string', () => {
        const r = parse(hex(64));
        expect(r.ok).toBe(true);
      });

      it('normalises uppercase to lowercase so comparison is total', () => {
        const upper = parse(`0x${'AB'.repeat(32)}`);
        const lower = parse(`0x${'ab'.repeat(32)}`);
        expect(upper.ok && lower.ok).toBe(true);
        if (upper.ok && lower.ok) expect(upper.value).toBe(lower.value);
      });

      it.each([
        ['missing 0x prefix', 'a'.repeat(64)],
        ['too short', hex(63)],
        ['too long', hex(65)],
        ['non-hex character', `0x${'z'.repeat(64)}`],
        ['empty', ''],
        ['only prefix', '0x'],
        ['embedded whitespace', `0x ${'a'.repeat(63)}`],
      ])('rejects %s', (_label, input) => {
        expect(parse(input).ok).toBe(false);
      });
    });
  }
});

describe('EvmAddress', () => {
  it('accepts a 20-byte address', () => {
    expect(parseEvmAddress(hex(40)).ok).toBe(true);
  });

  it.each([
    ['32-byte hash', hex(64)],
    ['19 bytes', hex(38)],
    ['21 bytes', hex(42)],
    ['no prefix', 'a'.repeat(40)],
  ])('rejects %s', (_label, input) => {
    expect(parseEvmAddress(input).ok).toBe(false);
  });

  it('never confuses an address with a blockchain id', () => {
    expect(parseEvmAddress(hex(64)).ok).toBe(false);
    expect(parseBlockchainId(hex(40)).ok).toBe(false);
  });
});

describe('numeric identifiers reject lossy input', () => {
  const parsers = {
    EvmChainId: parseEvmChainId,
    BlockNumber: parseBlockNumber,
    LogIndex: parseLogIndex,
  };

  for (const [label, parse] of Object.entries(parsers)) {
    describe(label, () => {
      it('accepts bigint and canonical decimal strings', () => {
        expect(parse(0n).ok).toBe(true);
        expect(parse('0').ok).toBe(true);
        expect(parse('43114').ok).toBe(true);
      });

      it('accepts values beyond Number.MAX_SAFE_INTEGER without precision loss', () => {
        const beyond = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
        const r = parse(beyond);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value as unknown as bigint).toBe(beyond);
      });

      it('rejects negatives', () => {
        expect(parse(-1n).ok).toBe(false);
        expect(parse('-1').ok).toBe(false);
      });

      it.each([
        ['leading zero', '007'],
        ['decimal point', '1.0'],
        ['hex', '0x10'],
        ['exponent', '1e3'],
        ['empty', ''],
        ['whitespace', ' 1'],
      ])('rejects non-canonical string %s', (_label, input) => {
        expect(parse(input).ok).toBe(false);
      });

      it('rejects a JS number outright, even inside the safe range', () => {
        expect(parse(1 as unknown as bigint).ok).toBe(false);
      });
    });
  }
});

describe('ProviderGroupId', () => {
  it('accepts lowercase slugs', () => {
    expect(parseProviderGroupId('infura').ok).toBe(true);
    expect(parseProviderGroupId('ava-labs-public').ok).toBe(true);
  });

  it.each([
    ['uppercase', 'Infura'],
    ['leading dash', '-infura'],
    ['trailing dash', 'infura-'],
    ['empty', ''],
    ['underscore', 'ava_labs'],
  ])('rejects %s', (_label, input) => {
    expect(parseProviderGroupId(input).ok).toBe(false);
  });
});

describe('property: hex parsing is total and never throws', () => {
  it('returns a Parsed result for arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const r = parseBlockHash(s);
        expect(typeof r.ok).toBe('boolean');
      }),
      { numRuns: 500 },
    );
  });

  it('accepts exactly the strings that are 32-byte hex', () => {
    const hexChar = fc.constantFrom(...'0123456789abcdef'.split(''));
    const hex64 = fc.array(hexChar, { minLength: 64, maxLength: 64 }).map((cs) => cs.join(''));
    fc.assert(
      fc.property(hex64, (h) => {
        expect(parseBlockHash(`0x${h}`).ok).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
