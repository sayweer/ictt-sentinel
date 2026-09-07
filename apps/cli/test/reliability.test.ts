import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  symlinkSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildBundle, verifyBundle, type EvidenceBundle } from '@ictt-sentinel/evidence';
import { quickstartBundleDraft } from '@ictt-sentinel/testkit';
import { writeAtomic } from '../src/atomic-write.js';
import { replayOffline } from '../src/offline-replay.js';
import { run, HELP } from '../src/run.js';
import { emitJson } from '../src/output.js';
import { exitCodeForVerdict } from '../src/exit-codes.js';

const root = () => mkdtempSync(join(tmpdir(), 'ictt-m11-reliability-'));
const invoke = (argv: string[], env: Record<string, string | undefined> = {}) => {
  let stdout = '',
    stderr = '';
  const code = run({
    argv,
    writer: {
      out: (t) => {
        stdout += t;
      },
      err: (t) => {
        stderr += t;
      },
    },
    env,
    evidenceDir: root(),
    version: '0.0.0',
    isTty: false,
  });
  return { code, stdout, stderr };
};
describe('CLI reliability', () => {
  it.each([
    ['check', '--fixture'],
    ['check', '--fixture', '--json'],
    ['check', '--fixture', 'healthy', 'ignored'],
    ['check', '--fixture', 'healthy', '--resume'],
    ['check', '--fixture', 'healthy', '--fixture', 'deficit'],
  ])('rejects malformed arguments: %j', (...args) => {
    expect(invoke(args).code).toBe(5);
  });
  it('does not mark unknown doctor checks ready even with all secrets present', () => {
    const r = invoke(['doctor', '--json'], {
      ICTT_SENTINEL_HOME_RPC_PRIMARY: 'set',
      ICTT_SENTINEL_HOME_RPC_SECONDARY: 'set',
      DATABASE_URL: 'set',
    });
    expect(r.code).toBe(3);
    expect(JSON.parse(r.stdout)).toMatchObject({ ready: false, telemetry: false });
  });
  it.each(['OK', 'CRITICAL', 'UNKNOWN', 'WARN'] as const)('maps %s independently', (status) => {
    expect(exitCodeForVerdict({ protocolStatus: status })).toBe(
      { OK: 0, CRITICAL: 2, UNKNOWN: 3, WARN: 4 }[status],
    );
  });
  it('writes valid structured JSON after credential redaction', () => {
    let out = '';
    emitJson(
      {
        out: (t) => {
          out += t;
        },
        err: () => undefined,
      },
      'test',
      { detail: 'https://rpc.invalid/key?x="quoted"', authorization: 'short-secret' },
    );
    expect(() => {
      JSON.parse(out);
    }).not.toThrow();
    expect(out).not.toContain('short-secret');
    expect(out).not.toContain('rpc.invalid');
  });
  it('pins the exact help output', () => {
    expect(HELP).toMatchSnapshot();
  });
  it('version and exported producer share the actual artifact checksum', () => {
    const dir = root();
    let output = '';
    const writer = {
      out: (t: string) => {
        output += t;
      },
      err: () => undefined,
    };
    const options = { writer, env: {}, evidenceDir: dir, version: '0.0.0', isTty: false };
    expect(run({ ...options, argv: ['--version', '--json'] })).toBe(0);
    const version = JSON.parse(output) as { artifactChecksum: string; buildCommit: string };
    expect(run({ ...options, argv: ['evidence', 'export', '--fixture', 'healthy'] })).toBe(0);
    const bundle = JSON.parse(
      readFileSync(join(dir, 'healthy.evidence.json'), 'utf8'),
    ) as EvidenceBundle;
    expect(bundle.core.producer.artifactChecksum).toBe(version.artifactChecksum);
    expect(bundle.core.producer.buildCommit).toBe(version.buildCommit);
    expect(verifyBundle(bundle).verified).toBe(true);
  });
  it('handles a real SIGINT during publication without corrupting the bundle', () => {
    const dir = root();
    const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
    const program = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { pathToFileURL } from 'node:url';
      const original = fs.fsyncSync;
      let signalled = false;
      fs.fsyncSync = (...args) => {
        original(...args);
        if (!signalled) { signalled = true; process.kill(process.pid, 'SIGINT'); }
      };
      syncBuiltinESMExports();
      process.argv = [process.execPath, ${JSON.stringify(entry)}, 'evidence', 'export', '--fixture', 'healthy'];
      await import(pathToFileURL(${JSON.stringify(entry)}).href);
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', program], {
      cwd: dir,
      env: {},
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(child.status).toBe(6);
    const bundle = JSON.parse(
      readFileSync(join(dir, 'evidence-out/healthy.evidence.json'), 'utf8'),
    ) as EvidenceBundle;
    expect(verifyBundle(bundle).verified).toBe(true);
    expect(readdirSync(join(dir, 'evidence-out')).some((name) => name.startsWith('tmp-'))).toBe(
      false,
    );
  });
  it('executes the built binary in non-TTY mode with no global install', () => {
    const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
    const out = execFileSync(process.execPath, [entry, 'check', '--fixture', 'healthy', '--json'], {
      encoding: 'utf8',
      env: {},
      cwd: root(),
    });
    expect(JSON.parse(out)).toMatchObject({ protocolStatus: 'OK', exitCode: 0 });
  });
});

describe('atomic file publication', () => {
  it.each(['opened', 'synced', 'renamed'] as const)(
    'survives failure at %s without partial output or foreign cleanup',
    (phase) => {
      const dir = root();
      writeAtomic(dir, 'bundle.json', 'old');
      writeFileSync(join(dir, 'foreign.tmp'), 'keep');
      expect(() =>
        writeAtomic(dir, 'bundle.json', 'new', (p) => {
          if (p === phase) throw new Error('simulated crash');
        }),
      ).toThrow();
      expect(readFileSync(join(dir, 'bundle.json'), 'utf8')).toBe(
        phase === 'renamed' ? 'new' : 'old',
      );
      expect(readFileSync(join(dir, 'foreign.tmp'), 'utf8')).toBe('keep');
      expect(readdirSync(dir).sort()).toEqual(['bundle.json', 'foreign.tmp']);
    },
  );
  it('rejects symlink roots and preserves targets', () => {
    const dir = root(),
      target = root(),
      link = join(dir, 'link');
    symlinkSync(target, link);
    expect(() => writeAtomic(link, 'bundle.json', 'data')).toThrow();
    expect(readdirSync(target)).toEqual([]);
  });
  it('writes complete UTF-8 content with private permissions', () => {
    const dir = root(),
      content = 'Türkçe 🧾'.repeat(100000);
    const written = writeAtomic(dir, 'bundle.json', content);
    expect(readFileSync(written.path, 'utf8')).toBe(content);
    expect(written.bytes).toBe(Buffer.byteLength(content));
    expect(statSync(written.path).mode & 0o777).toBe(0o600);
  });
});

describe('bounded pinned replay', () => {
  it('resumes only the identical input and leaves disagreement checkpoints untouched', () => {
    const dir = root(),
      bundle = buildBundle(quickstartBundleDraft('healthy'));
    expect(replayOffline(bundle, dir, { maxFacts: 1, resume: false })).toMatchObject({
      complete: false,
      cursor: 1,
    });
    const path = join(dir, 'replay-checkpoint.json');
    const before = readFileSync(path, 'utf8');
    const disagree = buildBundle(quickstartBundleDraft('disagreement'));
    expect(replayOffline(disagree, dir, { maxFacts: 1, resume: false })).toMatchObject({
      complete: false,
      processed: 0,
    });
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(() => replayOffline(disagree, dir, { maxFacts: 1, resume: true })).toThrow();
    expect(replayOffline(bundle, dir, { maxFacts: 1, resume: true })).toMatchObject({
      complete: true,
      resumedFrom: 1,
      cursor: 2,
    });
  });
});
