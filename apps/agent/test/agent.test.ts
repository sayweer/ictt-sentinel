import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { loadManifest, loadPolicy, type Endpoint } from '@ictt-sentinel/config';
import { buildBundle } from '@ictt-sentinel/evidence';
import { quickstartBundleDraft } from '@ictt-sentinel/testkit';
import { describeConfig, loadAgentConfig } from '../src/config.js';
import { applyFreshness } from '../src/freshness.js';
import { evaluateHealth, type AgentState } from '../src/health.js';
import { ingest } from '../src/ingest.js';
import { createLogSource } from '../src/log-source.js';
import { AGENT_METRICS, MAX_SERIES_PER_METRIC, createAgentRegistry } from '../src/metrics.js';
import { buildWatchPlan } from '../src/plan.js';
import { supersededLanes } from '../src/runtime.js';
import { Scheduler, type JobOutcome } from '../src/scheduler.js';

const tick = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 1);
  });
const waitFor = async (condition: () => boolean): Promise<void> => {
  for (let i = 0; i < 100; i += 1) {
    if (condition()) return;
    await tick();
  }
  throw new Error('condition was not reached');
};

describe('bounded deployment scheduler', () => {
  it('enforces per-deployment single writer, global concurrency, dedup and backpressure', async () => {
    const releases = new Map<string, () => void>();
    const active = new Set<string>();
    let highWater = 0;
    const outcomes: JobOutcome[] = [];
    const scheduler = new Scheduler({
      maxConcurrency: 2,
      queueLimit: 3,
      jobTimeoutMs: 1_000,
      maxAttempts: 1,
      backoffMs: 1,
      now: () => 0,
      sleep: () => Promise.resolve(),
      run: (job) =>
        new Promise<void>((resolve) => {
          active.add(job.deploymentId);
          highWater = Math.max(highWater, active.size);
          releases.set(job.deploymentId, () => {
            active.delete(job.deploymentId);
            resolve();
          });
        }),
      onOutcome: (outcome) => outcomes.push(outcome),
    });

    expect(scheduler.submit({ deploymentId: 'a', kind: 'evaluate' })).toBe('queued');
    expect(scheduler.submit({ deploymentId: 'a', kind: 'evaluate' })).toBe('duplicate');
    expect(scheduler.submit({ deploymentId: 'b', kind: 'evaluate' })).toBe('queued');
    expect(scheduler.submit({ deploymentId: 'c', kind: 'evaluate' })).toBe('queued');
    expect(scheduler.submit({ deploymentId: 'd', kind: 'evaluate' })).toBe('rejected-backpressure');
    scheduler.pump();
    await waitFor(() => active.size === 2);
    expect(scheduler.submit({ deploymentId: 'a', kind: 'hint' })).toBe('duplicate');
    releases.get('b')?.();
    await waitFor(() => active.has('c'));
    expect(highWater).toBe(2);
    releases.get('a')?.();
    releases.get('c')?.();
    await scheduler.shutdown(100);
    expect(outcomes).toHaveLength(3);
    expect(scheduler.stats()).toMatchObject({
      queued: 0,
      active: 0,
      draining: true,
      rejectedForBackpressure: 1,
      deduplicated: 2,
    });
  });

  it('retries within budget and reports only bounded failure reasons', async () => {
    const outcomes: JobOutcome[] = [];
    const sleeps: number[] = [];
    let attempts = 0;
    const scheduler = new Scheduler({
      maxConcurrency: 1,
      queueLimit: 1,
      jobTimeoutMs: 100,
      maxAttempts: 2,
      backoffMs: 25,
      now: () => 10,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      run: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error('https://user:secret@rpc.example/private'))
          : Promise.resolve();
      },
      onOutcome: (outcome) => outcomes.push(outcome),
    });
    scheduler.submit({ deploymentId: 'a', kind: 'evaluate' });
    scheduler.pump();
    await waitFor(() => outcomes.length === 1);
    expect(sleeps).toEqual([25]);
    expect(outcomes[0]).toMatchObject({ result: 'succeeded', attempts: 2, reason: null });
    expect(JSON.stringify(outcomes)).not.toContain('rpc.example');
    await scheduler.shutdown(100);
  });

  it('applies a job deadline and bounds forced shutdown even if a dependency stalls', async () => {
    const outcomes: JobOutcome[] = [];
    const scheduler = new Scheduler({
      maxConcurrency: 1,
      queueLimit: 1,
      jobTimeoutMs: 5,
      maxAttempts: 1,
      backoffMs: 1,
      now: () => 0,
      sleep: () => Promise.resolve(),
      run: (_job, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(new Error('aborted'));
            },
            { once: true },
          );
        }),
      onOutcome: (outcome) => outcomes.push(outcome),
    });
    scheduler.submit({ deploymentId: 'a', kind: 'evaluate' });
    scheduler.pump();
    await waitFor(() => outcomes.length === 1);
    expect(outcomes[0]).toMatchObject({ result: 'timed-out', attempts: 1, reason: 'job timeout' });

    const stuck = new Scheduler({
      maxConcurrency: 1,
      queueLimit: 1,
      jobTimeoutMs: 60_000,
      maxAttempts: 1,
      backoffMs: 1,
      now: () => 0,
      sleep: () => Promise.resolve(),
      run: () => new Promise<void>(() => undefined),
      onOutcome: () => undefined,
    });
    stuck.submit({ deploymentId: 'b', kind: 'evaluate' });
    stuck.pump();
    await expect(stuck.shutdown(5)).resolves.toBeUndefined();
  });
});

describe('freshness and health', () => {
  it('degrades a stale previous OK to UNKNOWN and never clears a CRITICAL on age', () => {
    const policy = { maxAgeSeconds: 60, expiresAfterSeconds: 300 };
    expect(applyFreshness('OK', 0, 61_000, policy)).toMatchObject({
      verdict: 'UNKNOWN',
      stale: true,
      reportable: true,
    });
    expect(applyFreshness('CRITICAL', 0, 301_000, policy)).toMatchObject({
      verdict: 'CRITICAL',
      stale: true,
      reportable: false,
    });
  });

  it('keeps process liveness separate from truth-path readiness and hosted degradation', () => {
    const state: AgentState = {
      startedAtMs: 0,
      databaseReachable: true,
      schemaCurrent: true,
      deployments: [
        {
          deploymentId: 'acme-usdc',
          lastSuccessAtMs: 1_000,
          lastVerdict: 'UNKNOWN',
          consecutiveFailures: 0,
        },
      ],
      alertingDegraded: false,
      hostedIngestDegraded: true,
    };
    expect(evaluateHealth(state, 2_000, { maxEvaluationAgeSeconds: 60 })).toMatchObject({
      live: true,
      ready: false,
      reasons: ['DEPLOYMENT_VERDICT_UNKNOWN:acme-usdc'],
      degraded: ['HOSTED_INGEST_DEGRADED'],
    });
  });
});

describe('agent boundaries', () => {
  it('keeps local-only as default and omits credentials from config descriptions', () => {
    const config = loadAgentConfig({
      ICTT_SENTINEL_DATABASE_URL: 'postgres://operator:secret@db.example/sentinel',
      ICTT_SENTINEL_MANIFEST_PATH: '/config/manifest.yaml',
      ICTT_SENTINEL_POLICY_PATH: '/config/policy.yaml',
    });
    expect(config.sharingLevel).toBe('local-only');
    const described = JSON.stringify(describeConfig(config));
    expect(described).not.toContain('postgres://');
    expect(described).not.toContain('secret@');
    expect(() =>
      loadAgentConfig({
        ICTT_SENTINEL_DATABASE_URL: 'postgres://db.example/sentinel',
        ICTT_SENTINEL_MANIFEST_PATH: '/config/manifest.yaml',
        ICTT_SENTINEL_POLICY_PATH: '/config/policy.yaml',
        ICTT_SENTINEL_MINTER_PRIVATE_KEY: 'must-never-be-read',
      }),
    ).toThrow('signing material');
  });

  it('does not call hosted at local-only and treats hosted outage as an operational result', async () => {
    const evidence = buildBundle(quickstartBundleDraft('healthy'));
    const snapshot = structuredClone(evidence);
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('network partition'));
    const disabled = await ingest({
      hostedUrl: null,
      token: undefined,
      sharingLevel: 'local-only',
      bundle: evidence,
      timeoutMs: 10,
      signal: new AbortController().signal,
      fetcher,
    });
    expect(disabled.outcome).toBe('disabled');
    expect(fetcher).not.toHaveBeenCalled();

    const unavailable = await ingest({
      hostedUrl: 'https://hosted.example.com',
      token: 'test-ingestion-credential',
      sharingLevel: 'sanitized-metadata',
      bundle: evidence,
      timeoutMs: 10,
      signal: new AbortController().signal,
      fetcher,
    });
    expect(unavailable.outcome).toBe('unreachable');
    expect(evidence).toEqual(snapshot);
  });

  it('drops credential-shaped metrics labels and caps series cardinality', () => {
    const registry = createAgentRegistry();
    registry.increment(AGENT_METRICS.jobs, { deployment: 'https://secret.example/token' });
    for (let i = 0; i <= MAX_SERIES_PER_METRIC; i += 1) {
      registry.increment(AGENT_METRICS.jobs, { deployment: `deployment-${String(i)}` });
    }
    const text = registry.render();
    expect(text).not.toContain('secret.example');
    expect(registry.dropped).toBe(2);
  });
});

describe('ACP-194 accepted-state supersession', () => {
  // The example deployment's home declares evmChainId 43114 (C-Chain mainnet);
  // its remote is an L1 that ACP-194 does not touch. The home is put back on
  // accepted-quorum here, because that is the reading this guard is about.
  const manifest = loadManifest(readFileSync('config/deployments/example.ictt.yml', 'utf8')).value;
  manifest.spec.home.chain.finality.mode = 'accepted-quorum';
  const plan = buildWatchPlan(
    manifest,
    loadPolicy(readFileSync('config/policies/default.yml', 'utf8')).value,
  ).deployment;
  const helicon = Date.parse('2026-09-22T15:00:00.000Z');

  it('carries each lane identity from the reviewed manifest into the plan', () => {
    expect(plan.chains.map((c) => c.identity.evmChainId)).toEqual([43114n, 55555n]);
  });

  it('marks only the C-Chain lane, and only from the activation instant', () => {
    expect(supersededLanes(plan, new Date(helicon - 1000))).toEqual([]);
    expect(supersededLanes(plan, new Date(helicon))).toEqual([plan.chains[0]!.chainKey]);
  });
});

describe('witness counting in the live log source', () => {
  const endpoint = (
    id: string,
    trustDomain: string,
    providerGroup: string,
    secretRef = `RPC_${id.toUpperCase()}`,
  ): Endpoint => ({
    id,
    trustDomain,
    providerGroup,
    role: 'primary',
    secretRef,
    archiveDepth: 'full',
  });
  const witnesses = (
    endpoints: readonly Endpoint[],
    hosts: Readonly<Record<string, string>> = {},
  ) =>
    createLogSource({
      chains: [{ chainKey: 'c', endpoints, maxRangeBlocks: 10, finality: 'accepted-quorum' }],
      read: () => Promise.resolve('0x1'),
      hostnameOf: (e) => hosts[e.id] ?? `${e.id}.example.test`,
      signal: new AbortController().signal,
      now: () => new Date(0),
    }).providerGroups('c');

  it('counts two provider groups in one trust domain as one witness', () => {
    expect(
      witnesses([
        endpoint('a', 'alpha', 'x'),
        endpoint('b', 'alpha', 'y'),
        endpoint('c', 'beta', 'z'),
      ]),
    ).toEqual(['x+y', 'z']);
  });

  it('counts one endpoint listed under two labels as one witness', () => {
    expect(
      witnesses([
        endpoint('a', 'alpha', 'x', 'RPC_SHARED'),
        endpoint('b', 'beta', 'y', 'RPC_SHARED'),
      ]),
    ).toEqual(['x+y']);
    expect(
      witnesses([endpoint('a', 'alpha', 'x'), endpoint('b', 'beta', 'y')], {
        a: 'rpc.shared.test',
        b: 'rpc.shared.test',
      }),
    ).toEqual(['x+y']);
  });

  it('keeps genuinely separate declarations as separate witnesses', () => {
    expect(witnesses([endpoint('a', 'alpha', 'x'), endpoint('b', 'beta', 'y')])).toEqual([
      'x',
      'y',
    ]);
  });

  it('reads a merged witness through its next endpoint, never as a second witness', async () => {
    const tried: string[] = [];
    const source = createLogSource({
      chains: [
        {
          chainKey: 'c',
          endpoints: [endpoint('a', 'alpha', 'x'), endpoint('b', 'alpha', 'y')],
          maxRangeBlocks: 10,
          finality: 'accepted-quorum',
        },
      ],
      read: (e) => {
        tried.push(e.id);
        return e.id === 'a' ? Promise.reject(new Error('down')) : Promise.resolve('0x7');
      },
      hostnameOf: () => null,
      signal: new AbortController().signal,
      now: () => new Date(0),
    });
    expect(source.providerGroups('c')).toEqual(['x+y']);
    expect(await source.agreedAcceptedHead('c')).toBe(7n);
    expect(tried).toEqual(['a', 'b']);
  });
});

describe('settled-quorum lanes', () => {
  const endpoint = (id: string, trustDomain: string): Endpoint => ({
    id,
    trustDomain,
    providerGroup: `${trustDomain}-g`,
    role: 'primary',
    secretRef: `RPC_${id.toUpperCase()}`,
    archiveDepth: 'full',
  });
  const block = (n: bigint) => ({
    number: `0x${n.toString(16)}`,
    hash: `0x${n.toString(16).padStart(64, '0')}`,
    parentHash: `0x${(n - 1n).toString(16).padStart(64, '0')}`,
    timestamp: '0x1',
  });

  it("anchors the head on each witness's finalized block, never its executed block number", async () => {
    const asked: string[] = [];
    const finalized: Record<string, bigint> = { a: 100n, b: 97n };
    const source = createLogSource({
      chains: [
        {
          chainKey: 'c',
          endpoints: [endpoint('a', 'alpha'), endpoint('b', 'beta')],
          maxRangeBlocks: 10,
          finality: 'settled-quorum',
        },
      ],
      read: (e, op) => {
        asked.push(op.op === 'block-by-ref' && op.ref.kind === 'tag' ? op.ref.tag : op.op);
        return op.op === 'head-block-number'
          ? Promise.resolve('0x3e8')
          : Promise.resolve(block(finalized[e.id]!));
      },
      hostnameOf: () => null,
      signal: new AbortController().signal,
      now: () => new Date(0),
    });
    expect(await source.agreedAcceptedHead('c')).toBe(97n);
    expect(asked).toEqual(['finalized', 'finalized']);
  });

  it('is never listed as superseded, while an accepted lane on the same chain is', () => {
    const manifest = loadManifest(
      readFileSync('config/deployments/example.ictt.yml', 'utf8'),
    ).value;
    const policy = loadPolicy(readFileSync('config/policies/default.yml', 'utf8')).value;
    const after = new Date(Date.parse('2026-09-22T15:00:00.000Z'));
    manifest.spec.home.chain.finality.mode = 'accepted-quorum';
    expect(supersededLanes(buildWatchPlan(manifest, policy).deployment, after)).toHaveLength(1);
    manifest.spec.home.chain.finality.mode = 'settled-quorum';
    expect(supersededLanes(buildWatchPlan(manifest, policy).deployment, after)).toEqual([]);
  });
});

describe('required witness count', () => {
  it('takes the stricter of the policy floor and the chain quorum', () => {
    const manifest = loadManifest(
      readFileSync('config/deployments/example.ictt.yml', 'utf8'),
    ).value;
    const policy = loadPolicy(readFileSync('config/policies/default.yml', 'utf8')).value;
    manifest.spec.home.chain.quorum.independentTrustDomains = 3;
    const required = buildWatchPlan(manifest, policy).deployment.chains.map(
      (c) => c.config.agreement.requiredIndependentGroups,
    );
    expect(policy.spec.quorum.minIndependentTrustDomains).toBe(2);
    expect(required).toEqual([3, 2]);
  });
});
