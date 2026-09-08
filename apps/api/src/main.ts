#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { EnvSource } from '@ictt-sentinel/config';
import { loadApiConfig } from './config.js';
import { openPostgresStore } from './postgres.js';
import { buildApi } from './server.js';

export interface ApiProcess {
  readonly address: string;
  close(): Promise<void>;
}

export const startApi = async (env: EnvSource): Promise<ApiProcess> => {
  const config = loadApiConfig(env);
  const database = openPostgresStore(config.databaseUrl);
  const app = buildApi({
    store: database.store,
    bodyLimit: config.bodyLimit,
    rateLimit: config.rateLimit,
    webhookSecret: (tenantId, sourceId) => {
      const ref = config.webhookSecretRefs.get(`${tenantId}/${sourceId}`);
      return ref === undefined ? undefined : env[ref];
    },
  });
  try {
    const address = await app.listen({ host: config.host, port: config.port });
    return {
      address,
      close: async () => {
        await app.close();
        await database.close();
      },
    };
  } catch (error) {
    await app.close();
    await database.close();
    throw error;
  }
};

const direct = (): boolean => {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(realpathSync(entry)).href === import.meta.url;
};

if (direct()) {
  const api = await startApi(process.env);
  const stop = (): void => {
    void api.close().finally(() => {
      process.exitCode = 0;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
