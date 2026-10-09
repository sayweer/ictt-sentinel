import { describe, expect, it } from 'vitest';
import { verifyBundle } from '@ictt-sentinel/evidence';
import { SOURCE_LOCK_DOCUMENT_DIGEST, collectConfigured } from '../src/index.js';
import { healthy, simulate } from './world.js';

const producer = {
  producer: 'ictt-sentinel' as const,
  buildCommit: 'test-build',
  artifactChecksum: 'c'.repeat(64),
};

const run = (sim: ReturnType<typeof simulate>, manifest = sim.manifest) =>
  collectConfigured({
    manifest,
    policy: sim.policy,
    pins: null,
    env: sim.env,
    runtime: sim.reader,
    maxLogs: 1000,
    producer,
    sourceLockHash: SOURCE_LOCK_DOCUMENT_DIGEST,
    signal: new AbortController().signal,
  });

describe('collectConfigured', () => {
  it('builds evidence that names its producer and source lock and verifies offline', async () => {
    const r = await run(simulate(healthy()));
    if (r.status !== 'evidence') throw new Error(r.reasons.join(', '));
    expect(verifyBundle(r.bundle).verified).toBe(true);
    expect(r.bundle.core.producer).toMatchObject(producer);
    expect(r.bundle.core.sourceLock.sourceLockHash).toBe(SOURCE_LOCK_DOCUMENT_DIGEST);
    expect(r.bundle.core.verdict.protocolStatus).toBe('OK');
  });

  it('answers UNKNOWN for a native deployment instead of guessing', async () => {
    const sim = simulate(healthy());
    const native = {
      ...sim.manifest,
      value: {
        ...sim.manifest.value,
        spec: {
          ...sim.manifest.value.spec,
          asset: { ...sim.manifest.value.spec.asset, mode: 'native' as const },
        },
      },
    };
    expect(await run(sim, native)).toEqual({
      status: 'unknown',
      reasons: ['native-collector-not-implemented'],
    });
  });
});
