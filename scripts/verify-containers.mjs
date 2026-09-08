#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const COMPOSE = join(ROOT, 'infra/postgres/docker-compose.yml');
const CONTAINERFILE = join(ROOT, 'infra/containers/Containerfile');
const failures = [];
const fail = (message) => failures.push(message);

const containerfile = readFileSync(CONTAINERFILE, 'utf8');
const exactNode =
  'node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e';
for (const line of containerfile.split('\n').filter((line) => line.startsWith('FROM node:'))) {
  if (!line.startsWith(`FROM ${exactNode} `)) fail(`external base is not exact: ${line}`);
}
if (!containerfile.includes('USER 10001:10001')) fail('runtime user is not fixed non-root UID/GID');
if (/^ARG\s+.*(?:secret|token|password|key)/im.test(containerfile)) {
  fail('secret-shaped build argument is forbidden');
}
if (!containerfile.includes(' AS build') || !containerfile.includes(' AS runtime-base')) {
  fail('Containerfile must use separate build and runtime stages');
}

const env = {
  ...process.env,
  POSTGRES_DB: 'ictt_sentinel',
  POSTGRES_USER: 'ictt_local',
  POSTGRES_PASSWORD: 'container-config-dummy-only',
  ICTT_SENTINEL_MIGRATOR_DATABASE_URL:
    'postgres://migrator:container-config-dummy-only@ictt-sentinel-postgres/ictt_sentinel',
  ICTT_SENTINEL_AGENT_DATABASE_URL:
    'postgres://runtime:container-config-dummy-only@ictt-sentinel-postgres/ictt_sentinel',
  ICTT_SENTINEL_API_DATABASE_URL:
    'postgres://runtime:container-config-dummy-only@ictt-sentinel-postgres/ictt_sentinel',
  ICTT_SENTINEL_AGENT_ENV_FILE: '/dev/null',
  ICTT_SENTINEL_API_ENV_FILE: '/dev/null',
  ICTT_SENTINEL_MANIFEST_FILE: join(ROOT, 'config/deployments/example.ictt.yml'),
  ICTT_SENTINEL_POLICY_FILE: join(ROOT, 'config/policies/default.yml'),
};
const rendered = spawnSync(
  'docker',
  [
    'compose',
    '--file',
    COMPOSE,
    '--profile',
    'agent',
    '--profile',
    'api',
    '--profile',
    'migrate',
    'config',
    '--format',
    'json',
  ],
  { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
);
if (rendered.status !== 0) {
  fail(`docker compose config failed: ${(rendered.stderr || 'unknown error').trim()}`);
}

let compose;
try {
  compose = JSON.parse(rendered.stdout);
} catch {
  fail('docker compose config did not return JSON');
}

const services = compose?.services ?? {};
const applicationServices = [
  ['ictt-sentinel-agent', 'agent'],
  ['ictt-sentinel-api', 'api'],
  ['ictt-sentinel-migrate', 'migrate'],
];
for (const [name, profile] of applicationServices) {
  const service = services[name];
  if (service === undefined) {
    fail(`${name} service is missing`);
    continue;
  }
  if (!service.profiles?.includes(profile)) fail(`${name} is missing ${profile} profile`);
  if (service.read_only !== true) fail(`${name} root filesystem is writable`);
  if (!service.cap_drop?.includes('ALL')) fail(`${name} does not drop all capabilities`);
  if (!service.security_opt?.includes('no-new-privileges:true')) {
    fail(`${name} lacks no-new-privileges`);
  }
  if (!service.tmpfs?.some((entry) => entry.includes('/tmp'))) fail(`${name} lacks /tmp tmpfs`);
  if (!(service.pids_limit > 0)) fail(`${name} lacks a PID limit`);
  if (!(service.mem_limit > 0)) fail(`${name} lacks a memory limit`);
  if (!(service.cpus > 0)) fail(`${name} lacks a CPU limit`);
  if (service.privileged === true) fail(`${name} is privileged`);
  if (service.network_mode === 'host') fail(`${name} uses host networking`);
  if ((service.volumes ?? []).some((volume) => JSON.stringify(volume).includes('docker.sock'))) {
    fail(`${name} mounts the Docker socket`);
  }
  if (service.build?.target !== profile) fail(`${name} uses the wrong build target`);
}

const postgres = services['ictt-sentinel-postgres'];
if (postgres === undefined) fail('ictt-sentinel-postgres service is missing');
else if (!String(postgres.image).includes('@sha256:'))
  fail('PostgreSQL image is not digest pinned');

if (failures.length > 0) {
  console.error(`verify:containers FAILED - ${String(failures.length)} problem(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('verify:containers OK - exact images, profiles and runtime restrictions checked');
