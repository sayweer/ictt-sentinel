import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { buildBundle, verifyBundle, type EvidenceBundle } from '@ictt-sentinel/evidence';
import { quickstartAggregation, quickstartBundleDraft } from '@ictt-sentinel/testkit';
import { EXIT } from '../src/exit-codes.js';
import { JSON_SCHEMA_VERSION, type Writer } from '../src/output.js';
import { HELP, parseArgs, run } from '../src/run.js';
import { resolveEvidencePath, UnsafeEvidencePathError, writeAtomic } from '../src/atomic-write.js';

/**
 * The CLI is the first surface a user actually touches, so its contract - exit
 * codes, stream discipline, and refusing to write something unshareable - is
 * tested as carefully as the engine behind it.
 */

const roots: string[] = [];
const tempRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ictt-cli-'));
  roots.push(dir);
  return dir;
};

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

interface Captured {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** JSON output is a documented contract, so the tests read it as a typed shape. */
interface CliOutput {
  schemaVersion: string;
  producer: string;
  version: string;
  createdNothing: boolean;
  approvedManifestModified: boolean;
  note: string;
  files: string[];
  verified: boolean;
  findings: { failure: string }[];
  trustBoundary: string[];
}
const parseOut = (captured: Captured): CliOutput => JSON.parse(captured.stdout) as CliOutput;

const invoke = (
  argv: readonly string[],
  over: {
    env?: Record<string, string | undefined>;
    evidenceDir?: string;
    readBundle?: (p: string) => EvidenceBundle;
  } = {},
): Captured => {
  let stdout = '';
  let stderr = '';
  const writer: Writer = {
    out: (t) => {
      stdout += t;
    },
    err: (t) => {
      stderr += t;
    },
  };
  const code = run({
    argv,
    writer,
    env: over.env ?? { ICTT_SENTINEL_HOME_RPC_PRIMARY: 'set', ICTT_SENTINEL_DATABASE_URL: 'set' },
    evidenceDir: over.evidenceDir ?? tempRoot(),
    version: '0.0.0',
    isTty: false,
    ...(over.readBundle ? { readBundle: over.readBundle } : {}),
  });
  return { code, stdout, stderr };
};

describe('exit codes', () => {
  it('is 0 only for an overall OK', () => {
    expect(invoke(['check', '--fixture', 'healthy']).code).toBe(EXIT.ok);
  });

  it('is 3 for a required UNKNOWN, distinct from a breach', () => {
    const r = invoke(['check', '--fixture', 'disagreement']);
    expect(r.code).toBe(EXIT.requiredUnknown);
    expect(r.code).not.toBe(EXIT.critical);
  });

  it('is 2 for a proven breach', () => {
    expect(invoke(['check', '--fixture', 'deficit']).code).toBe(EXIT.critical);
  });

  it('is 5 for invalid configuration or arguments', () => {
    expect(invoke(['check', '--fixture', 'nope']).code).toBe(EXIT.invalidConfig);
    expect(invoke(['check']).code).toBe(EXIT.invalidConfig);
    expect(invoke(['no-such-command']).code).toBe(EXIT.invalidConfig);
    expect(invoke([]).code).toBe(EXIT.invalidConfig);
  });

  it('refuses an unknown flag instead of ignoring it', () => {
    // A typo'd flag silently doing nothing is how a CI job reports the wrong
    // thing for weeks.
    const r = invoke(['check', '--fixture', 'healthy', '--strict']);
    expect(r.code).toBe(EXIT.invalidConfig);
    expect(r.stderr).toContain('unknown option');
  });

  it('reports a missing prerequisite as config, not as a verdict', () => {
    const r = invoke(['doctor'], { env: {} });
    expect(r.code).toBe(EXIT.invalidConfig);
    expect(r.code).not.toBe(EXIT.critical);
  });

  it('never reports an internal fault as a healthy result', () => {
    const r = invoke(['evidence', 'verify', '--file', '/nonexistent'], {
      readBundle: () => {
        throw new Error('boom');
      },
    });
    expect(r.code).toBe(EXIT.internalError);
    expect(r.code).not.toBe(EXIT.ok);
  });
});

describe('stream discipline', () => {
  it('puts machine JSON on stdout and nothing else', () => {
    const r = invoke(['check', '--fixture', 'healthy', '--json']);
    expect(() => {
      JSON.parse(r.stdout);
    }).not.toThrow();
    expect(parseOut(r).schemaVersion).toBe(JSON_SCHEMA_VERSION);
  });

  it('puts human output on stderr, so a JSON pipe stays clean', () => {
    const r = invoke(['check', '--fixture', 'healthy']);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('protocol_status');
  });

  it('keeps help on stderr too', () => {
    const r = invoke(['--help']);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('USAGE');
  });

  it('reports the same identity from --version as the evidence producer', () => {
    const r = invoke(['--version', '--json']);
    const parsed = parseOut(r);
    expect(parsed.producer).toBe('ictt-sentinel');
    expect(parsed.version).toBe('0.0.0');
    expect(buildBundle(quickstartBundleDraft('healthy')).core.producer.producer).toBe(
      parsed.producer,
    );
  });
});

describe('--help golden', () => {
  it('documents every command and every exit code', () => {
    for (const cmd of [
      'init',
      'discover',
      'doctor',
      'replay',
      'check',
      'evidence export',
      'evidence verify',
    ]) {
      expect(HELP).toContain(cmd);
    }
    for (const code of ['0', '2', '3', '4', '5', '6']) {
      expect(HELP).toMatch(new RegExp(`\\n  ${code}  `));
    }
  });

  it('states plainly that the tool cannot write to a chain', () => {
    expect(HELP).toContain('holds no key, sends no transaction and can pause nothing');
  });

  it('offers no signer, send, pause or retry command', () => {
    for (const forbidden of ['sign', 'send', 'pause', 'mint', 'burn', 'withdraw']) {
      expect(HELP.toLowerCase()).not.toMatch(new RegExp(`^\\s+${forbidden}\\b`, 'm'));
    }
  });
});

describe('parseArgs', () => {
  it('separates positionals, flags and their values', () => {
    const a = parseArgs(['evidence', 'export', '--fixture', 'healthy', '--json']);
    expect(a.command).toBe('evidence');
    expect(a.sub).toBe('export');
    expect(a.fixture).toBe('healthy');
    expect(a.json).toBe(true);
  });

  it('collects unknown flags rather than dropping them', () => {
    expect(parseArgs(['check', '--wat']).unknownFlags).toEqual(['--wat']);
  });
});

describe('init and discover', () => {
  it('init writes nothing and asks for no secret', () => {
    const r = invoke(['init', '--json']);
    const parsed = parseOut(r);
    expect(parsed.createdNothing).toBe(true);
    expect(r.stdout.toLowerCase()).not.toContain('password');
    expect(r.stdout).toContain('.env.example');
  });

  it('discover never modifies the approved manifest', () => {
    const parsed = parseOut(invoke(['discover', '--json']));
    expect(parsed.approvedManifestModified).toBe(false);
    expect(parsed.note).toContain('cannot approve');
  });

  it('doctor reports presence without printing a value', () => {
    const r = invoke(['doctor', '--json'], {
      env: {
        ICTT_SENTINEL_HOME_RPC_PRIMARY: 'https://secret.example/key123',
        ICTT_SENTINEL_DATABASE_URL: 'set',
      },
    });
    expect(r.stdout).toContain('present');
    // The value must not appear anywhere, in any form.
    expect(r.stdout).not.toContain('secret.example');
    expect(r.stdout).not.toContain('key123');
  });
});

describe('evidence export and verify', () => {
  it('writes both projections and reports the verdict, not merely "written"', () => {
    const dir = tempRoot();
    const r = invoke(['evidence', 'export', '--fixture', 'healthy', '--json'], {
      evidenceDir: dir,
    });
    expect(r.code).toBe(EXIT.ok);
    const parsed = parseOut(r);
    expect(parsed.files).toHaveLength(2);
    for (const f of parsed.files) expect(existsSync(f)).toBe(true);
  });

  it('carries the verdict of the exported bundle into the exit code', () => {
    const dir = tempRoot();
    expect(invoke(['evidence', 'export', '--fixture', 'deficit'], { evidenceDir: dir }).code).toBe(
      EXIT.critical,
    );
  });

  it('creates files that are not world readable', () => {
    const dir = tempRoot();
    invoke(['evidence', 'export', '--fixture', 'healthy'], { evidenceDir: dir });
    const mode = statSync(join(dir, 'healthy.evidence.json')).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });

  it('leaves no temp file behind', () => {
    const dir = tempRoot();
    invoke(['evidence', 'export', '--fixture', 'healthy'], { evidenceDir: dir });
    const leftovers = readFileSync(join(dir, 'healthy.evidence.json'), 'utf8');
    expect(leftovers.length).toBeGreaterThan(0);
    expect(existsSync(join(dir, `healthy.evidence.json.tmp-${String(process.pid)}`))).toBe(false);
  });

  it('verifies a bundle it just wrote', () => {
    const dir = tempRoot();
    invoke(['evidence', 'export', '--fixture', 'healthy'], { evidenceDir: dir });
    const bundle = JSON.parse(
      readFileSync(join(dir, 'healthy.evidence.json'), 'utf8'),
    ) as EvidenceBundle;
    const r = invoke(['evidence', 'verify', '--file', 'x', '--fixture', 'healthy', '--json'], {
      readBundle: () => bundle,
    });
    expect(r.code).toBe(EXIT.ok);
    expect(parseOut(r).verified).toBe(true);
  });

  it('fails verification when one byte of the bundle changed', () => {
    const bundle = buildBundle(quickstartBundleDraft('healthy'));
    const tampered: EvidenceBundle = {
      ...bundle,
      core: { ...bundle.core, deploymentId: `${bundle.core.deploymentId}!` },
    };
    const r = invoke(['evidence', 'verify', '--file', 'x', '--json'], {
      readBundle: () => tampered,
    });
    expect(r.code).not.toBe(EXIT.ok);
    expect(parseOut(r).findings[0]?.failure).toBe('content-hash-mismatch');
  });

  it('always states what verification does NOT establish', () => {
    const r = invoke(['evidence', 'verify', '--file', 'x', '--json'], {
      readBundle: () => buildBundle(quickstartBundleDraft('healthy')),
    });
    const boundary = parseOut(r).trustBoundary;
    expect(boundary.join(' ')).toContain('NOT verified here');
    expect(boundary.join(' ')).toContain('not tamper-proof');
  });
});

describe('offline verifier', () => {
  it('refuses an unknown schema version rather than best-effort parsing', () => {
    const bundle = buildBundle(quickstartBundleDraft('healthy'));
    const future = {
      ...bundle,
      core: {
        ...bundle.core,
        producer: { ...bundle.core.producer, schemaVersion: 'ictt-sentinel/evidence/v99' },
      },
    } as unknown as EvidenceBundle;
    const r = verifyBundle(future, null);
    expect(r.verified).toBe(false);
    expect(r.findings[0]?.failure).toBe('schema-version-unknown');
  });

  it('does not verify a bundle that admits missing evidence', () => {
    const bundle = buildBundle(quickstartBundleDraft('disagreement'));
    const r = verifyBundle(bundle, { aggregation: quickstartAggregation('disagreement') });
    expect(r.verified).toBe(false);
    expect(r.findings.map((f) => f.failure)).toContain('missing-required-evidence');
  });

  it('detects a replayed verdict that disagrees with the recorded one', () => {
    // The bundle claims healthy; replay the deficit inputs against it.
    const bundle = buildBundle(quickstartBundleDraft('healthy'));
    const r = verifyBundle(bundle, { aggregation: quickstartAggregation('deficit') });
    expect(r.verified).toBe(false);
    expect(r.findings.map((f) => f.failure)).toContain('verdict-mismatch');
  });

  it('detects a dangling internal reference', () => {
    const bundle = buildBundle(quickstartBundleDraft('healthy'));
    const broken: EvidenceBundle = {
      ...bundle,
      core: { ...bundle.core, rawFacts: [] },
    };
    const r = verifyBundle(broken, null);
    expect(r.findings.map((f) => f.failure)).toContain('dangling-reference');
  });
});

describe('atomic write safety', () => {
  it('refuses a path that escapes the evidence root', () => {
    const dir = tempRoot();
    expect(() => resolveEvidencePath(dir, '../escape.json')).toThrow(UnsafeEvidencePathError);
    expect(() => resolveEvidencePath(dir, '/etc/passwd')).toThrow(UnsafeEvidencePathError);
    expect(() => resolveEvidencePath(dir, 'nested/file.json')).toThrow(UnsafeEvidencePathError);
  });

  it('refuses a relative evidence root', () => {
    expect(() => resolveEvidencePath('relative/dir', 'a.json')).toThrow(UnsafeEvidencePathError);
  });

  it('replaces an existing file atomically', () => {
    const dir = tempRoot();
    writeAtomic(dir, 'a.json', 'first');
    writeAtomic(dir, 'a.json', 'second');
    expect(readFileSync(join(dir, 'a.json'), 'utf8')).toBe('second');
  });
});

describe('end to end over all three fixtures', () => {
  it.each([
    ['healthy', EXIT.ok, 'OK'],
    ['disagreement', EXIT.requiredUnknown, 'UNKNOWN'],
    ['deficit', EXIT.critical, 'CRITICAL'],
  ] as const)('%s exports, verifies and exits %i', (fixture, code, status) => {
    const dir = tempRoot();
    const exported = invoke(['evidence', 'export', '--fixture', fixture, '--json'], {
      evidenceDir: dir,
    });
    expect(exported.code).toBe(code);

    const bundle = JSON.parse(
      readFileSync(join(dir, `${fixture}.evidence.json`), 'utf8'),
    ) as EvidenceBundle;
    expect(bundle.core.verdict.protocolStatus).toBe(status);

    // The hash written to disk is the hash the verifier recomputes.
    const verified = verifyBundle(bundle, { aggregation: quickstartAggregation(fixture) });
    expect(verified.recomputedHash).toBe(bundle.contentHash);
    // Only the fully evidenced scenario verifies clean; the other two carry
    // findings by construction.
    expect(verified.verified).toBe(fixture !== 'disagreement');
  });
});

describe('binary identity', () => {
  it('maps exactly one binary, named ictt-sentinel', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { bin?: Record<string, string>; name?: string };
    expect(pkg.name).toBe('@ictt-sentinel/cli');
    expect(Object.keys(pkg.bin ?? {})).toEqual(['ictt-sentinel']);
    // A short, generic name on an operator's PATH is a collision waiting to
    // happen, so there is deliberately no `sentinel` alias.
    expect(Object.keys(pkg.bin ?? {})).not.toContain('sentinel');
  });

  it('points its bin at a file that starts with a node shebang', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { bin: Record<string, string> };
    const rel = pkg.bin['ictt-sentinel'];
    expect(rel).toBeDefined();
    const target = fileURLToPath(new URL(`../${String(rel)}`, import.meta.url));
    expect(existsSync(target), `${target} is not built; run pnpm run build`).toBe(true);
    expect(readFileSync(target, 'utf8').startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('is documented in the README without assuming a global install', () => {
    const readme = readFileSync(
      fileURLToPath(new URL('../../../README.md', import.meta.url)),
      'utf8',
    );
    expect(readme).toContain(
      'pnpm --filter @ictt-sentinel/cli exec ictt-sentinel check --fixture healthy',
    );
    expect(readme).toContain('pnpm run cli --');
    // All three fixtures reachable from the docs.
    for (const f of ['healthy', 'disagreement', 'deficit']) {
      expect(readme).toContain(`--fixture ${f}`);
    }
  });
});
