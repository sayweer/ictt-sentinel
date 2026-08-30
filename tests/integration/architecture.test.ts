import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

interface RunResult {
  status: number;
  output: string;
}

const run = (script: string): RunResult => {
  try {
    const output = execFileSync(process.execPath, [join(ROOT, 'scripts', script)], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
};

/** Files created by a test so a failure cannot leave the repository dirty. */
const created: string[] = [];
const scratch = (relPath: string, contents: string): void => {
  const full = join(ROOT, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, contents, 'utf8');
  created.push(full);
};

afterEach(() => {
  while (created.length > 0) {
    const f = created.pop();
    if (f !== undefined) rmSync(f, { force: true });
  }
});

const workspaceDirs = (): string[] => {
  const out: string[] = [];
  for (const base of ['apps', 'packages']) {
    for (const entry of readdirSync(join(ROOT, base))) {
      if (statSync(join(ROOT, base, entry)).isDirectory()) out.push(`${base}/${entry}`);
    }
  }
  return out;
};

describe('the repository is clean under every gate', () => {
  it('check-boundaries passes', () => {
    const r = run('check-boundaries.mjs');
    expect(r.output).toContain('check-boundaries OK');
    expect(r.status).toBe(0);
  });

  it('check-secrets passes', () => {
    const r = run('check-secrets.mjs');
    expect(r.output).toContain('check-secrets OK');
    expect(r.status).toBe(0);
  });

  it('verify-scaffold passes', () => {
    const r = run('verify-scaffold.mjs');
    expect(r.output).toContain('verify:scaffold OK');
    expect(r.status).toBe(0);
  });

  it('verify-config passes', () => {
    const r = run('verify-config.mjs');
    expect(r.output).toContain('verify:config OK');
    expect(r.status).toBe(0);
  });
});

// A gate that cannot fail is not a gate. Each case injects one real violation
// and asserts the checker reports it with a non-zero exit.
describe('boundary checker rejects real violations', () => {
  it('flags an import a package has not declared', () => {
    scratch(
      'packages/domain/src/__violation.ts',
      "import { PACKAGE_NAME } from '@ictt-sentinel/alerts';\nexport const x = PACKAGE_NAME;\n",
    );
    const r = run('check-boundaries.mjs');
    expect(r.status).toBe(1);
    expect(r.output).toContain('undeclared-dependency');
  });

  it('flags a layer-0 package importing a lower layer upward', () => {
    scratch(
      'packages/invariant-core/src/__violation.ts',
      "import { PACKAGE_NAME } from '@ictt-sentinel/rpc-quorum';\nexport const x = PACKAGE_NAME;\n",
    );
    const r = run('check-boundaries.mjs');
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/undeclared-dependency|layer-direction/);
  });

  it('flags a network import inside the pure core', () => {
    scratch(
      'packages/domain/src/__violation.ts',
      "import { createServer } from 'node:http';\nexport const x = createServer;\n",
    );
    const r = run('check-boundaries.mjs');
    expect(r.status).toBe(1);
    expect(r.output).toContain('purity');
  });

  it('flags a filesystem import inside the pure core', () => {
    scratch(
      'packages/state-machine/src/__violation.ts',
      "import { readFileSync } from 'node:fs';\nexport const x = readFileSync;\n",
    );
    const r = run('check-boundaries.mjs');
    expect(r.status).toBe(1);
    expect(r.output).toContain('purity');
  });

  it.each([
    ['process.env', 'export const x = process.env.HOME_RPC_URL;\n'],
    ['Date.now()', 'export const x = Date.now();\n'],
    ['new Date()', 'export const x = new Date();\n'],
    ['Math.random()', 'export const x = Math.random();\n'],
  ])('flags %s inside the pure core', (_label, body) => {
    scratch('packages/domain/src/__violation.ts', body);
    const r = run('check-boundaries.mjs');
    expect(r.status).toBe(1);
    expect(r.output).toContain('purity');
  });

  it('flags an import of a workspace package that does not exist', () => {
    scratch(
      'packages/config/src/__violation.ts',
      "import { a } from '@ictt-sentinel/does-not-exist';\nexport const x = a;\n",
    );
    const r = run('check-boundaries.mjs');
    expect(r.status).toBe(1);
    expect(r.output).toContain('unknown-workspace-import');
  });

  it('does not flag an impure import outside the pure core', () => {
    scratch(
      'packages/storage-postgres/src/__allowed.ts',
      "import { readFileSync } from 'node:fs';\nexport const x = readFileSync;\n",
    );
    const r = run('check-boundaries.mjs');
    expect(r.status).toBe(0);
  });
});

describe('secret scanner rejects real credential material', () => {
  // Assembled at runtime rather than written out, so this file does not itself
  // contain the literal patterns. That keeps the scanner free of an exemption
  // list, which would otherwise be a place for a real secret to hide.
  const pem = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ');
  const aws = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');
  const minterEnv = ['MINTER', 'PRIVATE', 'KEY'].join('_');

  it.each([
    ['PEM private key', `const k = \`${pem}\`;\n`],
    ['EVM private key', `const privateKey = "0x${'a'.repeat(64)}";\n`],
    ['AWS access key', `const id = "${aws}";\n`],
    ['GitHub token', `const t = "ghp_${'a'.repeat(36)}";\n`],
    ['forbidden env usage', `export const k = process.env.${minterEnv};\n`],
  ])('flags %s', (_label, body) => {
    scratch('packages/config/src/__violation.ts', body);
    const r = run('check-secrets.mjs');
    expect(r.status).toBe(1);
    expect(r.output).toContain('check-secrets FAILED');
  });

  it('does not flag an env reference that names a permitted variable', () => {
    scratch('packages/config/src/__allowed.ts', 'export const k = "HOME_RPC_URL";\n');
    const r = run('check-secrets.mjs');
    expect(r.status).toBe(0);
  });
});

describe('workspace naming contract', () => {
  it('every package is named @ictt-sentinel/<dir>', () => {
    for (const dir of workspaceDirs()) {
      const pkg = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8')) as {
        name: string;
      };
      const leaf = dir.split('/')[1] ?? '';
      expect(pkg.name).toBe(`@ictt-sentinel/${leaf}`);
    }
  });

  it('every dependency range is exact or the workspace protocol', () => {
    const manifests = ['package.json', ...workspaceDirs().map((d) => `${d}/package.json`)];
    for (const m of manifests) {
      const pkg = JSON.parse(readFileSync(join(ROOT, m), 'utf8')) as Record<
        string,
        Record<string, string> | undefined
      >;
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
        for (const [name, range] of Object.entries(pkg[field] ?? {})) {
          const exact = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(range) || range === 'workspace:*';
          expect(exact, `${m}: ${field}.${name} = ${range}`).toBe(true);
        }
      }
    }
  });

  it('the declared layer graph has no upward edge', () => {
    const layers = new Map<string, number>();
    const edges = new Map<string, string[]>();
    for (const dir of workspaceDirs()) {
      const pkg = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8')) as {
        name: string;
        'ictt-sentinel': { layer: number; mayDependOn: string[] };
      };
      layers.set(pkg.name, pkg['ictt-sentinel'].layer);
      edges.set(pkg.name, pkg['ictt-sentinel'].mayDependOn);
    }
    for (const [name, deps] of edges) {
      for (const dep of deps) {
        expect(layers.get(dep), `${dep} is unknown`).toBeDefined();
        expect(layers.get(dep)!, `${name} -> ${dep}`).toBeLessThanOrEqual(layers.get(name)!);
      }
    }
  });

  it('domain is the dependency root', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'packages/domain/package.json'), 'utf8')) as {
      'ictt-sentinel': { layer: number; mayDependOn: string[] };
    };
    expect(pkg['ictt-sentinel'].layer).toBe(0);
    expect(pkg['ictt-sentinel'].mayDependOn).toEqual([]);
  });
});
