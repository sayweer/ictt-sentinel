import { readFileSync } from 'node:fs';
import type { EvidenceBundle } from '@ictt-sentinel/evidence';
import { QUICKSTART_SCENARIOS, SCENARIO_SUMMARY } from '@ictt-sentinel/testkit';
import { EXIT, EXIT_MEANING, type ExitCode } from './exit-codes.js';
import { emitHuman, emitJson, type Writer } from './output.js';
import {
  check,
  discover,
  doctor,
  evidenceExport,
  evidenceVerify,
  init,
  replay,
  type CommandContext,
} from './commands.js';

/**
 * Argument parsing and dispatch.
 *
 * Hand-rolled rather than pulling in a parser: the surface is seven commands and
 * four flags, and a runtime dependency here would sit inside the trust boundary
 * of a security tool for no benefit.
 *
 * `run` returns an exit code. Nothing in this file calls `process.exit`, so the
 * whole CLI is testable in-process and a cancellation cannot strand a side effect.
 */

export const BINARY = 'ictt-sentinel' as const;

export interface RunOptions {
  readonly argv: readonly string[];
  readonly writer: Writer;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly evidenceDir: string;
  readonly version: string;
  readonly isTty: boolean;
  /** Injected so tests do not touch the filesystem for verify. */
  readonly readBundle?: (path: string) => EvidenceBundle;
}

const HELP = `${BINARY} - keyless, read-only assurance for Avalanche ICM/ICTT deployments

USAGE
  ${BINARY} <command> [options]

COMMANDS
  init                    Print setup guidance. Never asks for or writes a secret.
  discover                Produce a candidate manifest draft and a diff. Never approves.
  doctor                  Check readiness. Reports secret PRESENCE, never a value.
  replay   --fixture <s>  Replay a bounded, pinned range. Offline against a fixture.
  check    --fixture <s>  Evaluate and report the verdict.
  evidence export --fixture <s>   Write a reproducible evidence bundle (JSON + HTML).
  evidence verify --file <path> [--fixture <s>]
                          Verify a bundle offline and re-run the engine.

OPTIONS
  --json                  Machine output on stdout. Human output always goes to stderr.
  --evidence-dir <path>   Where bundles are written. Default: ./evidence-out
  --version               Build identity. Matches the evidence producer identity.
  --help                  This text.

FIXTURES
${QUICKSTART_SCENARIOS.map((s) => `  ${s.padEnd(14)}${SCENARIO_SUMMARY[s]}`).join('\n')}

EXIT CODES
${Object.entries(EXIT_MEANING)
  .map(([code, meaning]) => `  ${code}  ${meaning}`)
  .join('\n')}

This tool holds no key, sends no transaction and can pause nothing.
`;

interface ParsedArgs {
  readonly command: string;
  readonly sub: string | null;
  readonly json: boolean;
  readonly help: boolean;
  readonly version: boolean;
  readonly fixture: string | null;
  readonly file: string | null;
  readonly evidenceDir: string | null;
  readonly unknownFlags: readonly string[];
}

export const parseArgs = (argv: readonly string[]): ParsedArgs => {
  const positional: string[] = [];
  const unknownFlags: string[] = [];
  let json = false;
  let help = false;
  let version = false;
  let fixture: string | null = null;
  let file: string | null = null;
  let evidenceDir: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === undefined) continue;
    if (!a.startsWith('-')) {
      positional.push(a);
      continue;
    }
    switch (a) {
      case '--json':
        json = true;
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      case '--version':
      case '-V':
        version = true;
        break;
      case '--fixture':
        i += 1;
        fixture = argv[i] ?? null;
        break;
      case '--file':
        i += 1;
        file = argv[i] ?? null;
        break;
      case '--evidence-dir':
        i += 1;
        evidenceDir = argv[i] ?? null;
        break;
      default:
        // Refused rather than ignored: a typo'd flag silently doing nothing is
        // how a CI job reports the wrong thing for weeks.
        unknownFlags.push(a);
    }
  }

  return {
    command: positional[0] ?? '',
    sub: positional[1] ?? null,
    json,
    help,
    version,
    fixture,
    file,
    evidenceDir,
    unknownFlags,
  };
};

export const run = (options: RunOptions): ExitCode => {
  const args = parseArgs(options.argv);
  const { writer } = options;

  if (args.unknownFlags.length > 0) {
    emitHuman(writer, `unknown option(s): ${args.unknownFlags.join(', ')}`);
    emitHuman(writer, `run \`${BINARY} --help\``);
    return EXIT.invalidConfig;
  }

  if (args.version) {
    // Identical to the evidence producer identity, so a bundle can be traced to
    // the build that made it.
    if (args.json)
      emitJson(writer, '--version', { producer: 'ictt-sentinel', version: options.version });
    else writer.err(`${BINARY} ${options.version}\n`);
    return EXIT.ok;
  }

  if (args.help || args.command === '' || args.command === 'help') {
    writer.err(HELP);
    return args.command === '' && !args.help ? EXIT.invalidConfig : EXIT.ok;
  }

  const ctx: CommandContext = {
    writer,
    json: args.json,
    evidenceDir: args.evidenceDir ?? options.evidenceDir,
    version: options.version,
    isTty: options.isTty,
  };

  try {
    switch (args.command) {
      case 'init':
        return init(ctx);
      case 'discover':
        return discover(ctx);
      case 'doctor':
        return doctor(ctx, options.env);
      case 'replay':
        return requireFixture(ctx, args.fixture, (f) => replay(ctx, f));
      case 'check':
        return requireFixture(ctx, args.fixture, (f) => {
          const r = check(ctx, f);
          return typeof r === 'number' ? r : r.exitCode;
        });
      case 'evidence':
        return evidence(ctx, args, options);
      default:
        emitHuman(writer, `unknown command ${JSON.stringify(args.command)}`);
        emitHuman(writer, `run \`${BINARY} --help\``);
        return EXIT.invalidConfig;
    }
  } catch (e) {
    // An internal fault is never reported as a verdict: it gets its own code so
    // a pipeline cannot mistake a crashed tool for a healthy deployment.
    emitHuman(writer, `internal error: ${e instanceof Error ? e.message : String(e)}`);
    return EXIT.internalError;
  }
};

const requireFixture = (
  ctx: CommandContext,
  fixture: string | null,
  fn: (fixture: string) => ExitCode,
): ExitCode => {
  if (fixture === null) {
    emitHuman(ctx.writer, `--fixture is required; one of: ${QUICKSTART_SCENARIOS.join(', ')}`);
    return EXIT.invalidConfig;
  }
  return fn(fixture);
};

const evidence = (ctx: CommandContext, args: ParsedArgs, options: RunOptions): ExitCode => {
  if (args.sub === 'export') {
    return requireFixture(ctx, args.fixture, (f) => evidenceExport(ctx, f));
  }
  if (args.sub === 'verify') {
    if (args.file === null) {
      emitHuman(ctx.writer, '--file is required for `evidence verify`');
      return EXIT.invalidConfig;
    }
    const read = options.readBundle ?? defaultReadBundle;
    const bundle = read(args.file);
    return evidenceVerify(ctx, bundle, args.fixture);
  }
  emitHuman(ctx.writer, 'usage: evidence <export|verify>');
  return EXIT.invalidConfig;
};

const defaultReadBundle = (path: string): EvidenceBundle =>
  JSON.parse(readFileSync(path, 'utf8')) as EvidenceBundle;

export { HELP };
