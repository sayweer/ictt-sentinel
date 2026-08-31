import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/errors.js';
import { collectSecretRefs, loadManifest, loadPolicy } from '../src/load.js';
import { exactReplayCapability, isApproved } from '../src/baseline.js';
import { VALID_MANIFEST, VALID_POLICY, mutate } from './fixtures.js';

/** Load and return the issue codes, asserting that loading failed at all. */
const codesFor = (source: string): string[] => {
  try {
    loadManifest(source);
  } catch (e) {
    if (e instanceof ConfigError) return e.issues.map((i) => i.code);
    throw e;
  }
  throw new Error('expected the manifest to be rejected, but it loaded');
};

describe('the shipped example documents are valid', () => {
  it('loads the example manifest', () => {
    const { value, digest } = loadManifest(VALID_MANIFEST);
    expect(value.kind).toBe('ICTTDeployment');
    expect(value.spec.assuranceMode).toBe('ACCEPTED_STATE_ASSURANCE');
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('loads the default policy', () => {
    const { value } = loadPolicy(VALID_POLICY);
    expect(value.kind).toBe('SentinelPolicy');
    expect(value.spec.verdictPrecedence).toEqual(['CRITICAL', 'UNKNOWN', 'WARN', 'OK']);
    expect(value.spec.dataPath.allowLatestFallback).toBe(false);
    expect(value.spec.tokenModes.native.allowExactSupplyClaim).toBe(false);
  });

  it('collects every secretRef and no URL', () => {
    const { value } = loadManifest(VALID_MANIFEST);
    const refs = collectSecretRefs(value);
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) {
      expect(r).toMatch(/^ICTT_SENTINEL_[A-Z0-9_]+$/);
      expect(r).not.toContain('://');
    }
  });

  it('opens exact replay only for an approved, anchored, quorate manifest', () => {
    const { value } = loadManifest(VALID_MANIFEST);
    expect(isApproved(value.spec.baseline)).toBe(true);
    expect(exactReplayCapability(value)).toEqual({ enabled: true, blockedBy: [] });
  });
});

describe('inline credential material is refused', () => {
  it('rejects an endpoint that carries a URL instead of a secretRef', () => {
    const bad = mutate(
      VALID_MANIFEST,
      '          secretRef: ICTT_SENTINEL_HOME_RPC_PRIMARY',
      "          url: 'https://api.example.org/ext/bc/C/rpc'",
    );
    expect(codesFor(bad)).toContain('FORBIDDEN_FIELD');
  });

  it('rejects a URL smuggled into a free-text field', () => {
    const bad = mutate(
      VALID_MANIFEST,
      '  operator: Example Operator Ltd',
      "  operator: 'https://user:pass@rpc.example.org/v3/abcdefabcdefabcdefabcdef'",
    );
    expect(codesFor(bad)).toContain('INLINE_SECRET');
  });

  it.each([
    ['authorization header', '  headers: {Authorization: Bearer abc}'],
    ['api key', '  apiKey: abcdefabcdefabcdefabcdef'],
    ['password', '  password: hunter2'],
    ['private key', '  privateKey: 0xdeadbeef'],
    ['signer', '  signer: 0x1234'],
    ['wallet', '  wallet: my-wallet'],
    ['mnemonic', '  mnemonic: abandon abandon abandon'],
    ['dsn', '  dsn: postgres://u:p@localhost/db'],
  ])('rejects a %s field anywhere in the document', (_label, line) => {
    const bad = mutate(VALID_MANIFEST, 'spec:\n', `spec:\n${line}\n`);
    expect(codesFor(bad)).toContain('FORBIDDEN_FIELD');
  });

  it('rejects a PEM private key as a value', () => {
    const pem = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ');
    const bad = mutate(VALID_MANIFEST, '  operator: Example Operator Ltd', `  operator: '${pem}'`);
    expect(codesFor(bad)).toContain('INLINE_SECRET');
  });
});

describe('schema strictness', () => {
  it('rejects an unknown property', () => {
    const bad = mutate(
      VALID_MANIFEST,
      '  assuranceMode:',
      '  unexpectedField: 1\n  assuranceMode:',
    );
    expect(codesFor(bad)).toContain('SCHEMA');
  });

  it('rejects a confirmation-depth field, which has no meaning on Avalanche', () => {
    const bad = mutate(
      VALID_MANIFEST,
      '        maxLagSeconds: 60',
      '        confirmations: 12\n        maxLagSeconds: 60',
    );
    expect(codesFor(bad)).toContain('SCHEMA');
  });

  it('rejects the experimental teleporterV2 source family', () => {
    const bad = mutate(
      VALID_MANIFEST,
      '      family: teleporter\n',
      '      family: teleporterV2\n',
    );
    expect(codesFor(bad)).toContain('SCHEMA');
  });

  it('rejects an independent-verification assurance claim', () => {
    const bad = mutate(
      VALID_MANIFEST,
      '  assuranceMode: ACCEPTED_STATE_ASSURANCE',
      '  assuranceMode: INDEPENDENT_ICM_VERIFICATION',
    );
    expect(codesFor(bad)).toContain('SCHEMA');
  });

  it('rejects an unknown future apiVersion, fail-closed', () => {
    const bad = mutate(
      VALID_MANIFEST,
      'apiVersion: sentinel.ictt/v1alpha1',
      'apiVersion: sentinel.ictt/v9',
    );
    expect(codesFor(bad)).toContain('UNSUPPORTED_API_VERSION');
  });

  it('rejects an apiVersion from a foreign group', () => {
    const bad = mutate(
      VALID_MANIFEST,
      'apiVersion: sentinel.ictt/v1alpha1',
      'apiVersion: attacker.example/v1',
    );
    expect(codesFor(bad)).toContain('UNKNOWN_API_VERSION');
  });
});

describe('chain identity must be complete and unambiguous', () => {
  it('rejects a chain with neither genesisHash nor trustedCheckpoint', () => {
    const bad = VALID_MANIFEST.replace(/^ {6}genesisHash: '0x3+'\n/m, '');
    expect(codesFor(bad)).toContain('SCHEMA');
  });

  it('rejects an EVM chainId supplied where an Avalanche blockchainID belongs', () => {
    const bad = mutate(
      VALID_MANIFEST,
      "      blockchainId: '0x1111111111111111111111111111111111111111111111111111111111111111'",
      '      blockchainId: 43114',
    );
    expect(codesFor(bad)).toContain('SCHEMA');
  });

  it('rejects a subnetId that repeats the blockchainId', () => {
    const bad = mutate(
      VALID_MANIFEST,
      "      subnetId: '0x2222222222222222222222222222222222222222222222222222222222222222'",
      "      subnetId: '0x1111111111111111111111111111111111111111111111111111111111111111'",
    );
    expect(codesFor(bad)).toContain('SCHEMA');
  });

  it('rejects a missing deployment block', () => {
    const bad = VALID_MANIFEST.replace(/^ {6}deploymentBlock: '38000000'\n/m, '');
    expect(codesFor(bad)).toContain('SCHEMA');
  });

  it('rejects a census window that starts after the TokenHome deployment block', () => {
    const bad = mutate(VALID_MANIFEST, "    fromBlock: '38000000'", "    fromBlock: '38000001'");
    expect(codesFor(bad)).toContain('SCHEMA');
  });

  it('rejects a census scope that claims every deployment on Avalanche', () => {
    const bad = mutate(
      VALID_MANIFEST,
      '    scope: registered-remotes-of-this-token-home',
      '    scope: all-avalanche-deployments',
    );
    expect(codesFor(bad)).toContain('SCHEMA');
  });
});

describe('quorum cannot be faked', () => {
  it('rejects a declared quorum larger than the distinct trust domains configured', () => {
    const bad = mutate(
      VALID_MANIFEST,
      '          trustDomain: provider-beta\n          providerGroup: provider-beta-prod\n          role: secondary\n          secretRef: ICTT_SENTINEL_HOME_RPC_SECONDARY',
      '          trustDomain: provider-alpha\n          providerGroup: provider-alpha-prod\n          role: secondary\n          secretRef: ICTT_SENTINEL_HOME_RPC_SECONDARY',
    );
    // home now has provider-alpha twice plus provider-gamma; raise the bar past
    // what the topology can supply.
    const worse = mutate(
      bad,
      '        independentTrustDomains: 2\n\n    tokenHome:',
      '        independentTrustDomains: 4\n\n    tokenHome:',
    );
    expect(codesFor(worse)).toContain('FAKE_QUORUM');
  });

  it('rejects two endpoints sharing one id', () => {
    const bad = mutate(
      VALID_MANIFEST,
      '        - id: home-secondary',
      '        - id: home-primary',
    );
    expect(codesFor(bad)).toContain('DUPLICATE_ENDPOINT');
  });

  it('counts one trust domain once, however many endpoints wear it', () => {
    // Two endpoints, one domain, quorum of 2: not enough independence.
    const collapsed = mutate(
      VALID_MANIFEST,
      '            trustDomain: provider-beta\n            providerGroup: provider-beta-prod\n            role: secondary',
      '            trustDomain: operator-self-hosted\n            providerGroup: operator-node-b\n            role: secondary',
    );
    expect(codesFor(collapsed)).toContain('FAKE_QUORUM');
  });
});

describe('finality semantics', () => {
  it('rejects accepted-quorum backed by endpoints that may return unfinalized state', () => {
    const bad = mutate(
      VALID_MANIFEST,
      '        acceptedStateQueries: accepted-only\n        maxLagSeconds: 60',
      '        acceptedStateQueries: may-include-unfinalized\n        maxLagSeconds: 60',
    );
    expect(codesFor(bad)).toContain('SCHEMA');
  });

  it('refuses settled-quorum until ACP-194 is actually implemented', () => {
    const bad = mutate(
      VALID_MANIFEST,
      '        mode: accepted-quorum\n',
      '        mode: settled-quorum\n',
    );
    expect(codesFor(bad)).toContain('UNSUPPORTED_API_VERSION');
  });

  it('rejects a missing finality block', () => {
    const bad = VALID_MANIFEST.replace(/^ {6}finality:\n(?:.*\n)*? {8}maxLagSeconds: 60\n/m, '');
    expect(codesFor(bad)).toContain('SCHEMA');
  });
});

describe('secretRef allowlist', () => {
  it.each([
    ['unprefixed', 'HOME_RPC_PRIMARY'],
    ['foreign prefix', 'AWS_SECRET_ACCESS_KEY'],
    ['process variable', 'PATH'],
    ['lowercase', 'ictt_sentinel_home_rpc_primary'],
  ])('rejects a %s secretRef', (_label, name) => {
    const bad = mutate(
      VALID_MANIFEST,
      'secretRef: ICTT_SENTINEL_HOME_RPC_PRIMARY',
      `secretRef: ${name}`,
    );
    expect(codesFor(bad)).toContain('SCHEMA');
  });

  it.each([
    'BRIDGE_PRIVATE_KEY',
    'MINTER_PRIVATE_KEY',
    'PAUSER_PRIVATE_KEY',
    'MULTISIG_SIGNER_KEY',
    'MNEMONIC',
    'SEED_PHRASE',
    'ICTT_SENTINEL_MINTER_PRIVATE_KEY',
    'ICTT_SENTINEL_HOT_WALLET',
  ])('refuses signing material named %s', (name) => {
    const bad = mutate(
      VALID_MANIFEST,
      'secretRef: ICTT_SENTINEL_HOME_RPC_PRIMARY',
      `secretRef: ${name}`,
    );
    expect(codesFor(bad)).toContain('SCHEMA');
  });
});

describe('baseline approval', () => {
  it('rejects a candidate that also carries an approval record', () => {
    const bad = mutate(VALID_MANIFEST, '    state: approved', '    state: candidate');
    expect(codesFor(bad)).toContain('SCHEMA');
  });

  it('keeps exact replay closed for an unapproved candidate', () => {
    const candidate = mutate(
      VALID_MANIFEST,
      `    state: approved
    approval:
      approvedBy: Example Operator Security Review
      approvedAt: '2026-08-31T00:00:00Z'
      # Digest of the candidate document that was actually read at review time.
      reviewedDigest: sha256:0000000000000000000000000000000000000000000000000000000000000000
      note: Initial baseline approved after the launch checklist.`,
      `    state: candidate
    discovery:
      discoveredAt: '2026-08-31T00:00:00Z'
      tool: ictt-sentinel discover
      atBlock: '38000000'`,
    );
    const { value } = loadManifest(candidate);
    expect(value.spec.baseline.state).toBe('candidate');
    const cap = exactReplayCapability(value);
    expect(cap.enabled).toBe(false);
    expect(cap.blockedBy.join(' ')).toContain('not been approved');
  });

  it('rejects a baseline missing a field policy', () => {
    const bad = VALID_MANIFEST.replace(/^ {6}census\.completeness: OBSERVE_ONLY\n/m, '');
    expect(codesFor(bad)).toContain('SCHEMA');
  });
});
