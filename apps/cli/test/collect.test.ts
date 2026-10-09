import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Endpoint } from '@ictt-sentinel/config';
import { verifyBundle, type EvidenceBundle } from '@ictt-sentinel/evidence';
import { runAsync } from '../src/configured.js';
import type { Runtime } from '../src/runtime.js';
import {
  E12,
  HOME,
  PIN,
  healthy,
  id,
  simulate,
  type World,
} from '../../../packages/collector/test/world.js';

/**
 * `collect` end to end against the shared simulated deployment, finishing with
 * the existing `check` command against the written bundle.
 */

const setup = (world: World, tamper?: (endpoint: Endpoint, logs: unknown[]) => unknown[]) => {
  const sim = simulate(world, tamper);
  const root = mkdtempSync(join(tmpdir(), 'ictt-collect-'));
  const paths = {
    manifest: join(root, 'manifest.json'),
    policy: join(root, 'policy.json'),
    out: join(root, 'out'),
  };
  writeFileSync(paths.manifest, sim.manifestText);
  writeFileSync(paths.policy, sim.policyText);
  const env = { ...sim.env, DATABASE_URL: 'present' };
  const runtime: Runtime = { ...sim.reader, database: () => Promise.resolve(true) };
  const invoke = async (args: string[]) => {
    let stdout = '';
    const code = await runAsync(
      {
        argv: [...args, '--manifest', paths.manifest, '--policy', paths.policy, '--json'],
        env,
        evidenceDir: paths.out,
        version: '0.0.0',
        isTty: false,
        writer: {
          out: (text: string) => {
            stdout += text;
          },
          err: () => undefined,
        },
      },
      new AbortController().signal,
      runtime,
    );
    return { code, result: JSON.parse(stdout) as Record<string, unknown> };
  };
  return { invoke, paths };
};

const evidence = (out: string): EvidenceBundle =>
  JSON.parse(readFileSync(join(out, 'collected.evidence.json'), 'utf8')) as EvidenceBundle;

describe('live collection against a simulated deployment', () => {
  it('reconciles a healthy route and writes evidence the verifier and check accept', async () => {
    const f = setup(healthy());
    const r = await f.invoke(['collect', '--max-facts', '1000']);
    expect(r.result['reasons']).toBeUndefined();
    expect(r.code).toBe(0);
    const bundle = evidence(f.paths.out);
    expect(verifyBundle(bundle).verified).toBe(true);
    expect(bundle.core.verdict.protocolStatus).toBe('OK');
    expect(bundle.core.verdict.reasonCodes).toContain('ACC-A00-RECONCILED');
    expect(bundle.core.messages.map((m) => m.state).sort()).toEqual([
      'EXECUTED_SUCCESS',
      'EXECUTED_SUCCESS',
      'SOURCE_ACCOUNTED',
    ]);
    const check = await f.invoke([
      'check',
      '--file',
      join(f.paths.out, 'collected.evidence.json'),
      '--offline',
    ]);
    expect(check.code).toBe(0);
  });

  it('reports remote supply above home accounting as CRITICAL', async () => {
    const world = healthy();
    world.remoteSupply = 1400n * E12;
    const r = await setup(world).invoke(['collect', '--max-facts', '1000']);
    expect(r.code).toBe(2);
  });

  it('is UNKNOWN when one witness returns a different history', async () => {
    const f = setup(healthy(), (endpoint, logs) =>
      endpoint.id.endsWith('secondary') || endpoint.trustDomain === 'provider-1'
        ? logs.slice(1)
        : logs,
    );
    const r = await f.invoke(['collect', '--max-facts', '1000']);
    expect(r.code).toBe(3);
    expect(r.result['reasons']).toEqual(
      expect.arrayContaining([expect.stringContaining('witness-divergence')]),
    );
  });

  it('is UNKNOWN when an execution inside the cut has its source after the home pin', async () => {
    const world = healthy();
    // Message 1's home send moves past the home pin; remote still executed it.
    world.logs = world.logs.map((l) =>
      l.topics[1] === id(1) && l.chain === HOME ? { ...l, block: PIN + 1n } : l,
    );
    world.transferred = 300n * E12;
    const f = setup(world);
    const r = await f.invoke(['collect', '--max-facts', '1000']);
    expect(r.code).toBe(3);
    const bundle = evidence(f.paths.out);
    expect(verifyBundle(bundle).verified).toBe(true);
    expect(bundle.core.verdict.reasonCodes).toContain('ACC-I05-CAUSAL-CUT-OPEN');
  });

  it('refuses to scan more history than the bound allows', async () => {
    const r = await setup(healthy()).invoke(['collect', '--max-facts', '2']);
    expect(r.code).toBe(3);
    expect(r.result['reasons']).toEqual(
      expect.arrayContaining([expect.stringContaining('log-bound-exceeded')]),
    );
  });
});
