import { describe, expect, it } from 'vitest';
import { AUDIT_RECORDS, auditCoverageFor, validateDescriptor } from '../src/descriptor.js';
import {
  PINNED_BUILD,
  PINNED_COMMIT_SHA,
  PINNED_LIBRARIES,
  PINNED_REPOSITORY,
  SOURCE_DESCRIPTORS,
} from '../src/descriptors/generated.js';
import {
  INTERPRETABLE_FAMILIES,
  familyFromRegistryVersion,
  getDescriptor,
  resolveAdapter,
  sourceLockSummary,
} from '../src/registry.js';
import { PROVENANCE, UPSTREAM_AUDITS } from './provenance.js';
import type { ApprovedCodeHashes, ObservedContract } from '../src/fingerprint.js';

const hash = (seed: string): string => `0x${seed.repeat(64).slice(0, 64)}`;

describe('the source lock is pinned to an immutable commit', () => {
  it('names a full 40-character commit, never a branch', () => {
    expect(PINNED_COMMIT_SHA).toMatch(/^[0-9a-f]{40}$/);
    expect(PINNED_COMMIT_SHA).toBe(PROVENANCE.commitSha);
    expect(PINNED_REPOSITORY).toBe(PROVENANCE.repository);
    for (const moving of ['main', 'master', 'HEAD', 'latest']) {
      expect(PINNED_COMMIT_SHA).not.toContain(moving);
    }
  });

  it('records the build settings that produced the pinned artifacts', () => {
    expect(PINNED_BUILD.solcVersion).toBe('0.8.30');
    expect(PINNED_BUILD.evmVersion).toBe('shanghai');
    expect(PINNED_BUILD.optimizer).toBe(true);
    expect(PINNED_BUILD.optimizerRuns).toBe(200);
    // The official build strips metadata, so a bytecode hash cannot self-certify
    // its compiler. Recorded so the limitation is visible rather than assumed.
    expect(PINNED_BUILD.bytecodeHash).toBe('none');
  });

  it('pins every submodule that participates in compilation', () => {
    for (const [name, sha] of Object.entries(PINNED_LIBRARIES)) {
      expect(sha, name).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('every descriptor is structurally valid', () => {
    const problems = SOURCE_DESCRIPTORS.flatMap(validateDescriptor);
    expect(problems).toEqual([]);
  });

  it('every descriptor carries source, git blob and review metadata', () => {
    for (const d of SOURCE_DESCRIPTORS) {
      expect(d.sourceSha256, d.adapterId).toMatch(/^[0-9a-f]{64}$/);
      expect(d.sourceGitBlobSha, d.adapterId).toMatch(/^[0-9a-f]{40}$/);
      expect(d.sourcePath, d.adapterId).toMatch(/^icm-contracts\/avalanche\//);
      expect(d.reviewedAt, d.adapterId).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('every concrete contract carries an ABI and creation bytecode hash', () => {
    for (const d of SOURCE_DESCRIPTORS) {
      if (d.role === 'abstract-base' || d.role === 'library') continue;
      expect(d.abiSha256, d.adapterId).toMatch(/^[0-9a-f]{64}$/);
      expect(d.creationBytecodeSha256, d.adapterId).toMatch(/^[0-9a-f]{64}$/);
      expect(d.abiEntries ?? 0, d.adapterId).toBeGreaterThan(0);
    }
  });

  it('no two descriptors share an identity or a hash', () => {
    const ids = SOURCE_DESCRIPTORS.map((d) => d.adapterId);
    expect(new Set(ids).size).toBe(ids.length);
    const sources = SOURCE_DESCRIPTORS.map((d) => d.sourceSha256);
    expect(new Set(sources).size).toBe(sources.length);
    const creation = SOURCE_DESCRIPTORS.map((d) => d.creationBytecodeSha256).filter(
      (h): h is string => h !== undefined,
    );
    expect(new Set(creation).size).toBe(creation.length);
  });

  it('summarises what this build can interpret', () => {
    const s = sourceLockSummary();
    expect(s.descriptorCount).toBe(SOURCE_DESCRIPTORS.length);
    expect(s.bySupport.supported).toBeGreaterThan(0);
    expect(s.bySupport.unsupported).toBeGreaterThan(0);
  });
});

describe('audit claims are bound to the audited commit', () => {
  it('resolves every upstream short sha to a full commit', () => {
    for (const a of UPSTREAM_AUDITS) {
      expect(a.fullSha).toMatch(/^[0-9a-f]{40}$/);
      expect(a.fullSha.startsWith(a.shortSha)).toBe(true);
    }
    expect(AUDIT_RECORDS.length).toBe(UPSTREAM_AUDITS.length);
  });

  it('every audit covers a commit in the archived repository, not the pinned one', () => {
    for (const a of AUDIT_RECORDS) {
      expect(a.auditedRepository).toBe('https://github.com/ava-labs/icm-contracts');
      expect(a.auditedCommitSha).not.toBe(PINNED_COMMIT_SHA);
    }
  });

  it('refuses to claim audited status for the pinned source', () => {
    // The upstream audit index itself warns about code newer than the audited
    // commit. Claiming coverage here would be false.
    for (const d of SOURCE_DESCRIPTORS) {
      const coverage = auditCoverageFor(d, PINNED_COMMIT_SHA);
      expect(coverage).not.toBe('covered-at-pinned-commit');
    }
  });

  it('marks the experimental family as never audited', () => {
    const warp = getDescriptor('teleporter-v2-experimental.warp-adapter');
    expect(warp).toBeDefined();
    if (warp) expect(auditCoverageFor(warp, PINNED_COMMIT_SHA)).toBe('never-audited');
  });

  it('would report coverage only if the pinned commit were itself audited', () => {
    const d = getDescriptor('ictt.token-remote.erc20-upgradeable');
    expect(d).toBeDefined();
    if (d) {
      const auditedSha = AUDIT_RECORDS[2]?.auditedCommitSha ?? '';
      expect(auditCoverageFor(d, auditedSha)).toBe('covered-at-pinned-commit');
    }
  });
});

describe('the experimental teleporterV2 tree is a separate family', () => {
  it('is present in the source lock but marked unsupported', () => {
    const warp = getDescriptor('teleporter-v2-experimental.warp-adapter');
    expect(warp?.family).toBe('teleporter-v2-experimental');
    expect(warp?.support).toBe('unsupported');
  });

  it('is not an interpretable family', () => {
    expect(INTERPRETABLE_FAMILIES).not.toContain('teleporter-v2-experimental');
  });

  it('resolves to unsupported even when the fingerprint is known', () => {
    const warp = getDescriptor('teleporter-v2-experimental.warp-adapter');
    expect(warp).toBeDefined();
    const observed: ObservedContract = { address: hash('a'), runtimeCodeHash: hash('b') };
    const approved: ApprovedCodeHashes[] = [
      { adapterId: 'teleporter-v2-experimental.warp-adapter', runtimeCodeHashes: [hash('b')] },
    ];
    const r = resolveAdapter(observed, approved, 'teleporter-v2-experimental');
    expect(r.outcome).toBe('unsupported');
    expect(r.interpretable).toBe(false);
  });

  it('a registry protocol version cannot select a source family', () => {
    // The mistake has a name and a test rather than only a convention: a
    // registry version of 2 says nothing about which source tree is deployed.
    expect(() => familyFromRegistryVersion(2)).toThrow(
      /does not identify a protocol source family/,
    );
    expect(() => familyFromRegistryVersion(1)).toThrow();
  });

  it('a teleporter fingerprint never resolves under the experimental family', () => {
    const approved: ApprovedCodeHashes[] = [
      { adapterId: 'teleporter.messenger', runtimeCodeHashes: [hash('c')] },
    ];
    const observed: ObservedContract = { address: hash('a'), runtimeCodeHash: hash('c') };
    // Manifest says experimental; the family gate refuses before fingerprinting.
    expect(resolveAdapter(observed, approved, 'teleporter-v2-experimental').outcome).toBe(
      'unsupported',
    );
    // Manifest says teleporter; the same fingerprint resolves.
    expect(resolveAdapter(observed, approved, 'teleporter').interpretable).toBe(true);
  });
});
