#!/usr/bin/env node
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadManifest, loadPolicy, type EnvSource } from '@ictt-sentinel/config';
import { createDb } from '@ictt-sentinel/storage-postgres';
import { loadAgentConfig } from './config.js';
import { createAgentService, type AgentService } from './daemon.js';
import { createLogSource } from './log-source.js';
import { AGENT_METRICS } from './metrics.js';
import { createEndpointReader } from './rpc.js';
import { Scheduler } from './scheduler.js';
import { createObserveServer } from './serve.js';

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const readConfig = (path: string): string => {
  if (statSync(path).size > MAX_CONFIG_BYTES) throw new Error('configuration file is too large');
  return readFileSync(path, 'utf8');
};

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    const cancel = (): void => {
      clearTimeout(timer);
      reject(new Error('cancelled'));
    };
    signal.addEventListener('abort', cancel, { once: true });
  });

const listen = (
  server: ReturnType<typeof createObserveServer>,
  port: number,
  host: string,
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

const closeServer = (server: ReturnType<typeof createObserveServer>): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });

export interface AgentProcess {
  readonly service: AgentService;
  close(): Promise<void>;
}

export const startAgent = async (env: EnvSource): Promise<AgentProcess> => {
  const config = loadAgentConfig(env);
  const manifest = loadManifest(readConfig(config.manifestPath)).value;
  const policy = loadPolicy(readConfig(config.policyPath)).value;
  const db = createDb(config.databaseUrl, {
    max: config.maxConcurrency + 2,
    statementTimeoutSeconds: Math.max(1, Math.ceil(config.jobTimeoutMs / 1000)),
  });
  const service: AgentService = createAgentService({
    config,
    manifest,
    policy,
    db,
    env,
    sourceFor: (signal, watchPlan) =>
      createLogSource({
        chains: watchPlan.chains,
        read: createEndpointReader({ env, timeoutMs: policy.spec.dataPath.requestTimeoutMs }),
        signal,
        now: () => new Date(),
      }),
  });
  await service.hydrate();

  const scheduler = new Scheduler({
    maxConcurrency: config.maxConcurrency,
    queueLimit: config.queueLimit,
    jobTimeoutMs: config.jobTimeoutMs,
    maxAttempts: config.maxJobAttempts,
    backoffMs: config.backoffMs,
    now: Date.now,
    sleep,
    run: async (_job, signal) => {
      await service.evaluate(signal);
      await service.drain(signal);
    },
    onOutcome: (outcome) => {
      service.recordOutcome(outcome.result);
    },
  });

  const submit = (): void => {
    const result = scheduler.submit({
      deploymentId: service.plan.deployment.deploymentId,
      kind: 'evaluate',
    });
    if (result === 'rejected-backpressure') {
      service.registry.increment(AGENT_METRICS.backpressure, {
        deployment: service.plan.deployment.deploymentId,
      });
    }
    service.registry.set(AGENT_METRICS.queueDepth, scheduler.stats().queued, {
      deployment: service.plan.deployment.deploymentId,
    });
    scheduler.pump();
  };
  submit();
  const interval = setInterval(submit, config.tickIntervalMs);

  const observe = createObserveServer({
    host: config.observe.host,
    port: config.observe.port,
    context: () => ({
      state: service.state(),
      registry: service.registry,
      policy: { maxEvaluationAgeSeconds: policy.spec.evidence.maxAgeSeconds },
      nowMs: Date.now(),
    }),
  });
  if (config.observe.enabled) {
    try {
      await listen(observe, config.observe.port, config.observe.host);
    } catch (error) {
      clearInterval(interval);
      await scheduler.shutdown(config.shutdownGraceMs);
      await db.close();
      throw error;
    }
  }

  let closing: Promise<void> | null = null;
  return {
    service,
    close: () => {
      closing ??= (async () => {
        clearInterval(interval);
        await scheduler.shutdown(config.shutdownGraceMs);
        if (config.observe.enabled) await closeServer(observe);
        await db.close();
      })();
      return closing;
    },
  };
};

const direct = (): boolean => {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(realpathSync(entry)).href === import.meta.url;
};

if (direct()) {
  try {
    const agent = await startAgent(process.env);
    const stop = (): void => {
      void agent.close().then(
        () => {
          process.exitCode = 0;
        },
        () => {
          process.exitCode = 1;
        },
      );
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch {
    process.stderr.write('ictt-sentinel-agent failed to start\n');
    process.exitCode = 1;
  }
}
