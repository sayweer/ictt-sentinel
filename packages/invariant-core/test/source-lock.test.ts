import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PINNED_COMMIT_SHA, SOURCE_DESCRIPTORS } from '@ictt-sentinel/ictt-adapters';
import { SOURCE_LOCK_SHA } from '@ictt-sentinel/testkit';

/**
 * Gate A's precondition, kept checkable.
 *
 * The whole reconciliation rests on one verified fact: `getTransferredBalance`
 * and the canonical ERC20 remote's `totalSupply` are in the SAME (remote)
 * denomination, so `D - S` is a direct subtraction with no rescaling.
 *
 * That fact was established by downloading the pinned sources and matching their
 * sha256 against the recorded descriptors (docs/PROTOCOL_SOURCE_LOCK.md 9.2).
 * These tests make sure the pin cannot move underneath the claim without
 * somebody noticing.
 */

const SOURCE_LOCK_DOC = readFileSync(
  fileURLToPath(new URL('../../../docs/PROTOCOL_SOURCE_LOCK.md', import.meta.url)),
  'utf8',
);

/** The exact hashes verified during Milestone 09. */
const VERIFIED = [
  [
    'icm-contracts/avalanche/ictt/TokenHome/TokenHome.sol',
    '2eaedc8d0b307f33d42e32645656f7fc5ce8b6e0301829f4efda16463de83826',
  ],
  [
    'icm-contracts/avalanche/ictt/TokenRemote/TokenRemote.sol',
    'd7cbf77810f6a59842c90745c523a70bcd8be3015997e014a87341c9384f4719',
  ],
  [
    'icm-contracts/avalanche/ictt/TokenRemote/ERC20TokenRemote.sol',
    'aae93c0e8e15211aa720f6a88bdcbc2c60d6b0c21c4628c2cdf512593e32f585',
  ],
  [
    'icm-contracts/avalanche/ictt/TokenRemote/ERC20TokenRemoteUpgradeable.sol',
    'd620b70af3b78d0d7bb11224406989ebb4fe9f92f0760729ac760e4db77b7009',
  ],
] as const;

describe('source lock behind Gate A', () => {
  it('evaluates against the same commit the fixtures name', () => {
    expect(SOURCE_LOCK_SHA).toBe(PINNED_COMMIT_SHA);
  });

  it.each(VERIFIED)('still pins %s at the verified hash', (path, sha) => {
    const descriptor = SOURCE_DESCRIPTORS.find((d) => d.sourcePath === path);
    expect(descriptor, `no descriptor for ${path}`).toBeDefined();
    // If this fails the pin moved, and the denomination finding must be
    // re-verified against the new source before the equation is trusted again.
    expect(descriptor?.sourceSha256).toBe(sha);
  });

  it('records the denomination finding in the source lock document', () => {
    expect(SOURCE_LOCK_DOC).toContain('9.2 Milestone 09');
    expect(SOURCE_LOCK_DOC).toContain("denominated by the remote's token scale amount");
    expect(SOURCE_LOCK_DOC).toContain('prior to scaling');
  });

  it('still records that canonical ERC20 carries no initial collateral term', () => {
    // If this ever stops being true the equation needs a C_r term, and adding
    // one without re-reading the source would double count.
    expect(SOURCE_LOCK_DOC).toContain('`C_r` **yapısal olarak sıfırdır**');
  });

  it('keeps the ERC20 home and remote adapters supported', () => {
    const supported = SOURCE_DESCRIPTORS.filter((d) => d.support === 'supported').map(
      (d) => d.adapterId,
    );
    expect(supported).toContain('ictt.token-home.erc20');
    expect(supported).toContain('ictt.token-remote.erc20');
  });
});
