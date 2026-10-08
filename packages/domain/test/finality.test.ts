import { describe, expect, it } from 'vitest';
import { ACCEPTED_STATE_SUPERSESSIONS, acceptedStateSuperseded } from '../src/finality.js';

const MAINNET = { evmChainId: 43114n, blockchainId: ACCEPTED_STATE_SUPERSESSIONS[0]!.blockchainId };
const FUJI = { evmChainId: 43113n, blockchainId: ACCEPTED_STATE_SUPERSESSIONS[1]!.blockchainId };
const L1 = { evmChainId: 99999n, blockchainId: `0x${'ab'.repeat(32)}` };
const HELICON_MAINNET = 1_790_089_200n;
const HELICON_FUJI = 1_785_250_800n;

describe('ACP-194 accepted-state supersession', () => {
  it('pins the activation instants to the upstream schedule', () => {
    expect(new Date(Number(HELICON_MAINNET) * 1000).toISOString()).toBe('2026-09-22T15:00:00.000Z');
    expect(new Date(Number(HELICON_FUJI) * 1000).toISOString()).toBe('2026-07-28T15:00:00.000Z');
  });

  it.each([
    ['mainnet', MAINNET, HELICON_MAINNET],
    ['fuji', FUJI, HELICON_FUJI],
  ] as const)(
    'activates on %s at the upgrade timestamp, not one second earlier',
    (_, chain, at) => {
      expect(acceptedStateSuperseded(chain, at - 1n)).toBe(false);
      expect(acceptedStateSuperseded(chain, at)).toBe(true);
      expect(acceptedStateSuperseded(chain, at + 1n)).toBe(true);
    },
  );

  it('keys each network on its own schedule', () => {
    // Between the two activations Fuji is affected and mainnet is not.
    expect(acceptedStateSuperseded(FUJI, HELICON_MAINNET - 1n)).toBe(true);
    expect(acceptedStateSuperseded(MAINNET, HELICON_MAINNET - 1n)).toBe(false);
  });

  it('matches on either identifier, so a half-declared C-Chain is still affected', () => {
    expect(acceptedStateSuperseded({ ...L1, evmChainId: 43114n }, HELICON_MAINNET)).toBe(true);
    expect(
      acceptedStateSuperseded(
        { ...L1, blockchainId: MAINNET.blockchainId.toUpperCase().replace('0X', '0x') },
        HELICON_MAINNET,
      ),
    ).toBe(true);
  });

  it('leaves other chains on accepted-state semantics', () => {
    expect(acceptedStateSuperseded(L1, HELICON_MAINNET * 2n)).toBe(false);
  });
});
