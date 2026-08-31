import { describe, expect, it } from 'vitest';
import { checkLinkage, type HomeSideLinkage, type RemoteSideLinkage } from '../src/linkage.js';
import {
  buildCandidateCensus,
  diffAgainstBaseline,
  requireApprovedBaseline,
  type ApprovedRemote,
  type CensusInput,
} from '../src/discovery.js';
import {
  impliesSuccessfulExecution,
  transferShapeSupport,
  type MessageReceivedObservation,
  type RemoteRegisteredObservation,
} from '../src/observations.js';

const addr = (s: string): string => `0x${s.repeat(40).slice(0, 40)}`;
const b32 = (s: string): string => `0x${s.repeat(64).slice(0, 64)}`;

const HOME_CHAIN = b32('1');
const REMOTE_CHAIN = b32('2');
const TOKEN_HOME = addr('a');
const TOKEN_REMOTE = addr('b');
const REGISTRY = addr('c');

const home = (over: Partial<HomeSideLinkage> = {}): HomeSideLinkage => ({
  homeBlockchainId: HOME_CHAIN,
  tokenHomeAddress: TOKEN_HOME,
  tokenAddress: addr('d'),
  homeTokenDecimals: 6,
  teleporterRegistryAddress: REGISTRY,
  registeredRemote: {
    remoteBlockchainId: REMOTE_CHAIN,
    remoteTokenTransferrerAddress: TOKEN_REMOTE,
    registered: true,
    collateralNeeded: 0n,
    tokenMultiplier: 10n ** 12n,
    multiplyOnRemote: true,
  },
  ...over,
});

const remote = (over: Partial<RemoteSideLinkage> = {}): RemoteSideLinkage => ({
  remoteBlockchainId: REMOTE_CHAIN,
  tokenRemoteAddress: TOKEN_REMOTE,
  tokenHomeBlockchainId: HOME_CHAIN,
  tokenHomeAddress: TOKEN_HOME,
  remoteTokenDecimals: 18,
  tokenMultiplier: 10n ** 12n,
  multiplyOnRemote: true,
  teleporterRegistryAddress: REGISTRY,
  isCollateralized: true,
  initialReserveImbalance: 0n,
  ...over,
});

const faults = (h: HomeSideLinkage, r: RemoteSideLinkage): string[] =>
  checkLinkage(h, r).findings.map((f) => f.fault);

describe('home and remote must describe each other', () => {
  it('accepts a consistent pair', () => {
    const result = checkLinkage(home(), remote());
    expect(result.findings).toEqual([]);
    expect(result.linked).toBe(true);
  });

  it('rejects a remote the home never registered', () => {
    expect(faults(home({ registeredRemote: undefined }), remote())).toContain(
      'remote-not-registered-at-home',
    );
  });

  it('rejects a registration marked not registered', () => {
    const h = home();
    const unregistered = home({
      registeredRemote: { ...h.registeredRemote!, registered: false },
    });
    expect(faults(unregistered, remote())).toContain('remote-not-registered-at-home');
  });

  it('rejects a remote naming a different home chain', () => {
    expect(faults(home(), remote({ tokenHomeBlockchainId: b32('9') }))).toContain(
      'home-blockchain-id-mismatch',
    );
  });

  it('rejects a remote naming a different home address', () => {
    expect(faults(home(), remote({ tokenHomeAddress: addr('9') }))).toContain(
      'home-address-mismatch',
    );
  });

  it('rejects a home registration pointing at a different remote chain', () => {
    const h = home();
    const wrong = home({
      registeredRemote: { ...h.registeredRemote!, remoteBlockchainId: b32('9') },
    });
    expect(faults(wrong, remote())).toContain('remote-blockchain-id-mismatch');
  });

  it('rejects a home registration pointing at a different remote address', () => {
    const h = home();
    const wrong = home({
      registeredRemote: { ...h.registeredRemote!, remoteTokenTransferrerAddress: addr('9') },
    });
    expect(faults(wrong, remote())).toContain('remote-address-mismatch');
  });

  it('rejects a mismatched Teleporter registry', () => {
    expect(faults(home(), remote({ teleporterRegistryAddress: addr('9') }))).toContain(
      'teleporter-registry-mismatch',
    );
  });

  it('rejects disagreement on the scaling values', () => {
    expect(faults(home(), remote({ tokenMultiplier: 10n ** 6n }))).toContain('scaling-mismatch');
    expect(faults(home(), remote({ multiplyOnRemote: false }))).toContain('scaling-mismatch');
  });

  it('rejects scaling that both sides agree on but the protocol would not derive', () => {
    // 6 -> 18 must give 1e12 and multiplyOnRemote true. A pair that agrees on
    // something else is still wrong.
    const h = home();
    const agreed = home({
      registeredRemote: { ...h.registeredRemote!, tokenMultiplier: 10n ** 9n },
    });
    expect(faults(agreed, remote({ tokenMultiplier: 10n ** 9n }))).toContain(
      'derived-scaling-mismatch',
    );
  });

  it('rejects a pair with outstanding collateral', () => {
    const h = home();
    const owed = home({ registeredRemote: { ...h.registeredRemote!, collateralNeeded: 5n } });
    expect(faults(owed, remote())).toContain('collateral-outstanding');
  });

  it('refuses decimals the home contract itself would reject', () => {
    expect(faults(home(), remote({ remoteTokenDecimals: 19 }))).toContain('scaling-underivable');
  });
});

describe('delivery is not execution', () => {
  it('a received message does not imply successful execution', () => {
    const received: MessageReceivedObservation = {
      kind: 'teleporter.message-received',
      messageId: b32('7'),
      sourceBlockchainId: HOME_CHAIN,
      deliverer: addr('e'),
      source: {
        blockchainId: REMOTE_CHAIN,
        contractAddress: TOKEN_REMOTE,
        blockNumber: 10n,
        blockHash: b32('8'),
        txHash: b32('9'),
        txIndex: 0,
        logIndex: 0,
        adapterId: 'teleporter.messenger',
        adapterVersion: 1,
      },
    };
    expect(impliesSuccessfulExecution(received)).toBe(false);
  });

  it('only an executed observation implies execution', () => {
    expect(
      impliesSuccessfulExecution({
        ...({} as never),
        kind: 'teleporter.message-executed',
      } as never),
    ).toBe(true);
  });
});

describe('transfer shapes that are not flattened', () => {
  it('supports a single hop', () => {
    expect(transferShapeSupport('single-hop')).toBe('supported');
  });

  it.each(['multi-hop', 'remote-to-remote', 'send-and-call'] as const)(
    'refuses to model %s as a single hop',
    (shape) => {
      expect(transferShapeSupport(shape)).toBe('unknown');
    },
  );
});

// ------------------------------------------------------------------ census

const registration = (
  remoteChain: string,
  remoteAddr: string,
  block: bigint,
  decimals = 18,
): RemoteRegisteredObservation => ({
  kind: 'ictt.remote-registered',
  remoteBlockchainId: remoteChain,
  remoteTokenTransferrerAddress: remoteAddr,
  collateralNeeded: 0n,
  remoteTokenDecimals: decimals,
  source: {
    blockchainId: HOME_CHAIN,
    contractAddress: TOKEN_HOME,
    blockNumber: block,
    blockHash: b32('8'),
    txHash: b32('9'),
    txIndex: 0,
    logIndex: 0,
    adapterId: 'ictt.token-home.erc20-upgradeable',
    adapterVersion: 1,
  },
});

const census = (over: Partial<CensusInput> = {}): CensusInput => ({
  tokenHomeAddress: TOKEN_HOME,
  homeBlockchainId: HOME_CHAIN,
  tokenHomeDeploymentBlock: 100n,
  scannedFromBlock: 100n,
  scannedToBlock: 500n,
  hadLogGap: false,
  registrations: [registration(REMOTE_CHAIN, TOKEN_REMOTE, 120n)],
  ...over,
});

describe('census completeness is claimed only when it is established', () => {
  it('is complete when the scan starts at the deployment block with no gap', () => {
    const c = buildCandidateCensus(census());
    expect(c.completeness).toBe('complete-from-deployment-block');
    expect(c.remotes).toHaveLength(1);
  });

  it('is unknown without a trustworthy deployment block', () => {
    const c = buildCandidateCensus(census({ tokenHomeDeploymentBlock: undefined }));
    expect(c.completeness).toBe('unknown');
    expect(c.reasons.join(' ')).toContain('deployment block is unknown');
  });

  it('is unknown without a scan start block', () => {
    expect(buildCandidateCensus(census({ scannedFromBlock: undefined })).completeness).toBe(
      'unknown',
    );
  });

  it('is partial when the scan starts after the deployment block', () => {
    const c = buildCandidateCensus(census({ scannedFromBlock: 150n }));
    expect(c.completeness).toBe('partial');
    expect(c.reasons.join(' ')).toContain('earlier registrations were not observed');
  });

  it('is partial when the log scan had a gap', () => {
    expect(buildCandidateCensus(census({ hadLogGap: true })).completeness).toBe('partial');
  });

  it('never marks a discovered remote as trusted', () => {
    for (const r of buildCandidateCensus(census()).remotes) {
      expect(r.trusted).toBe(false);
    }
  });

  it('keeps the earliest sighting of a duplicated registration', () => {
    const c = buildCandidateCensus(
      census({
        registrations: [
          registration(REMOTE_CHAIN, TOKEN_REMOTE, 300n),
          registration(REMOTE_CHAIN, TOKEN_REMOTE, 120n),
        ],
      }),
    );
    expect(c.remotes).toHaveLength(1);
    expect(c.remotes[0]?.firstSeenBlock).toBe(120n);
  });

  it('is scoped to one TokenHome, never to a chain', () => {
    const c = buildCandidateCensus(census());
    expect(c.tokenHomeAddress).toBe(TOKEN_HOME.toLowerCase());
    expect(c.homeBlockchainId).toBe(HOME_CHAIN.toLowerCase());
  });
});

describe('discovery describes drift and never applies it', () => {
  const approvedRemotes: ApprovedRemote[] = [
    {
      remoteBlockchainId: REMOTE_CHAIN,
      remoteTokenTransferrerAddress: TOKEN_REMOTE,
      expectedDecimals: 18,
    },
  ];

  it('reports no drift when observation matches the baseline', () => {
    const diff = diffAgainstBaseline(buildCandidateCensus(census()), approvedRemotes, 'sha256:x');
    expect(diff.drift).toEqual([]);
    expect(diff.mutatesBaseline).toBe(false);
  });

  it('reports an unapproved remote as candidate drift, not as an addition', () => {
    const c = buildCandidateCensus(
      census({ registrations: [registration(b32('5'), addr('5'), 200n)] }),
    );
    const diff = diffAgainstBaseline(c, approvedRemotes, 'sha256:x');
    const kinds = diff.drift.map((d) => d.kind);
    expect(kinds).toContain('candidate-not-approved');
    expect(kinds).toContain('approved-not-observed');
    expect(diff.mutatesBaseline).toBe(false);
  });

  it('does not modify the approved baseline it was given', () => {
    const before = JSON.stringify(approvedRemotes);
    diffAgainstBaseline(buildCandidateCensus(census()), approvedRemotes, 'sha256:x');
    expect(JSON.stringify(approvedRemotes)).toBe(before);
  });

  it('reports a decimals mismatch against the baseline', () => {
    const c = buildCandidateCensus(
      census({ registrations: [registration(REMOTE_CHAIN, TOKEN_REMOTE, 120n, 6)] }),
    );
    const diff = diffAgainstBaseline(c, approvedRemotes, 'sha256:x');
    expect(diff.drift.map((d) => d.kind)).toContain('decimals-mismatch');
  });

  it('carries the census completeness into the diff', () => {
    const c = buildCandidateCensus(census({ hadLogGap: true }));
    expect(diffAgainstBaseline(c, approvedRemotes, 'sha256:x').censusCompleteness).toBe('partial');
  });
});

describe('an approved baseline is required before any verdict', () => {
  it('refuses without an approved manifest digest', () => {
    const gate = requireApprovedBaseline(undefined);
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.code).toBe('BASELINE_REQUIRED');
      expect(gate.reason).toContain('cannot stand in for an operator-approved baseline');
    }
  });

  it('refuses an empty digest', () => {
    expect(requireApprovedBaseline('').ok).toBe(false);
  });

  it('allows evaluation once a baseline is approved', () => {
    expect(requireApprovedBaseline('sha256:abc').ok).toBe(true);
  });
});
