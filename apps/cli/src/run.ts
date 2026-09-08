import { resolve } from 'node:path';
import { ConfigError } from '@ictt-sentinel/config';
import { InvalidCheckpointError } from './offline-replay.js';
import { buildIdentity } from './identity.js';
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
                          Verify self-contained inputs and re-run the pure engine.

OPTIONS
  --json                  Machine output on stdout. Human output always goes to stderr.
  --evidence-dir <path>   Where bundles are written. Default: ./evidence-out
  --max-facts <n>         Process at most n facts per offline replay (1..10000).
  --resume                Resume a checkpoint bound to the same bundle hash.
  --manifest <path>       Reviewed deployment YAML/JSON for configured commands.
  --policy <path>         Policy YAML/JSON; required with --manifest.
  --pins <path>           JSON array of blockchainId/blockNumber/blockHash pins.
  --offline               Replay the recorded snapshot; makes no current-health claim.
  --version               Build identity. Matches the evidence producer identity.
  --help                  This text.

FIXTURES
${QUICKSTART_SCENARIOS.map((s) => `  ${s.padEnd(14)}${SCENARIO_SUMMARY[s]}`).join('\n')}

EXIT CODES
${Object.entries(EXIT_MEANING)
  .map(([code, meaning]) => `  ${code}  ${meaning}`)
  .join('\n')}

CONFIGURED COMMANDS
  doctor --manifest <m> --policy <p> --pins <pins>
  discover --manifest <m> --policy <p> --pins <pins> [--resume]
  check|replay --manifest <m> --policy <p> --file <bundle> [--offline]
  evidence export --manifest <m> --policy <p> --file <bundle> [--offline]
  check/replay also accept --pins, --max-facts and --resume.
  Discovery scans one policy-bounded block range per invocation; --max-facts
  bounds returned registrations. Unknown remotes remain unapproved candidates.

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
  readonly maxFacts: number;
  readonly resume: boolean;
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
  let maxFacts = 100;
  let resume = false;
  const seen = new Set<string>();

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === undefined || (a === '--' && i === 0)) continue;
    if (!a.startsWith('-')) {
      positional.push(a);
      continue;
    }
    if (seen.has(a)) unknownFlags.push('duplicate option');
    seen.add(a);
    if (
      ['--fixture', '--file', '--evidence-dir', '--max-facts'].includes(a) &&
      (argv[i + 1] === undefined || argv[i + 1]?.startsWith('-'))
    ) {
      unknownFlags.push('missing option value');
      continue;
    }
    switch (a) {
      case '--resume':
        resume = true;
        break;
      case '--max-facts': {
        const raw = argv[++i] ?? '';
        if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > 10000)
          unknownFlags.push('invalid fact bound');
        else maxFacts = Number(raw);
        break;
      }
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

  if (positional.length > (positional[0] === 'evidence' ? 2 : 1))
    unknownFlags.push('extra positional argument');
  return {
    maxFacts,
    resume,
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
  try {
    return dispatch(options);
  } catch {
    emitHuman(options.writer, 'Internal operation failed; no untrusted error detail emitted.');
    if (options.argv.includes('--json'))
      emitJson(options.writer, 'error', { error: 'internal-error', exitCode: EXIT.internalError });
    return EXIT.internalError;
  }
};

const dispatch = (options: RunOptions): ExitCode => {
  const args = parseArgs(options.argv);
  const { writer } = options;

  const invalidUse =
    ((args.resume || args.maxFacts !== 100) && args.command !== 'replay') ||
    (args.file !== null && !(args.command === 'evidence' && args.sub === 'verify')) ||
    (args.fixture !== null && !['check', 'replay', 'discover', 'evidence'].includes(args.command));
  if (args.unknownFlags.length > 0 || invalidUse) {
    emitHuman(writer, `unknown option(s): ${args.unknownFlags.join(', ')}`);
    emitHuman(writer, `run \`${BINARY} --help\``);
    if (args.json)
      emitJson(writer, 'error', { error: 'invalid-arguments', exitCode: EXIT.invalidConfig });
    return EXIT.invalidConfig;
  }

  if (args.version) {
    // Identical to the evidence producer identity, so a bundle can be traced to
    // the build that made it.
    if (args.json) emitJson(writer, '--version', { ...buildIdentity(), version: options.version });
    else writer.err(`${BINARY} ${options.version} ${buildIdentity().artifactChecksum}\n`);
    return EXIT.ok;
  }

  if (args.help || args.command === '' || args.command === 'help') {
    if (args.json) emitJson(writer, '--help', { help: HELP });
    else writer.err(HELP);
    return args.command === '' && !args.help ? EXIT.invalidConfig : EXIT.ok;
  }

  const ctx: CommandContext = {
    writer,
    json: args.json,
    evidenceDir: args.evidenceDir === null ? options.evidenceDir : resolve(args.evidenceDir),
    version: options.version,
    isTty: options.isTty,
  };

  try {
    switch (args.command) {
      case 'init':
        return init(ctx);
      case 'discover':
        return discover(ctx, args.fixture);
      case 'doctor':
        return doctor(ctx, options.env);
      case 'replay':
        return requireFixture(ctx, args.fixture, (f) =>
          replay(ctx, f, { maxFacts: args.maxFacts, resume: args.resume }),
        );
      case 'check':
        return requireFixture(ctx, args.fixture, (f) => {
          const r = check(ctx, f);
          return typeof r === 'number' ? r : r.exitCode;
        });
      case 'evidence':
        return evidence(ctx, args, options);
      default:
        if (args.json)
          emitJson(writer, 'error', { error: 'unknown-command', exitCode: EXIT.invalidConfig });
        emitHuman(writer, `unknown command ${JSON.stringify(args.command)}`);
        emitHuman(writer, `run \`${BINARY} --help\``);
        return EXIT.invalidConfig;
    }
  } catch (e) {
    // An internal fault is never reported as a verdict: it gets its own code so
    // a pipeline cannot mistake a crashed tool for a healthy deployment.
    const code =
      e instanceof ConfigError || e instanceof InvalidCheckpointError || e instanceof SyntaxError
        ? EXIT.invalidConfig
        : EXIT.internalError;
    emitHuman(
      writer,
      code === EXIT.invalidConfig
        ? 'Invalid configuration, JSON or checkpoint.'
        : 'Internal operation failed; no untrusted error detail emitted.',
    );
    if (args.json)
      emitJson(writer, args.command, {
        error: code === EXIT.invalidConfig ? 'invalid-config' : 'internal-error',
        exitCode: code,
      });
    return code;
  }
};

const requireFixture = (
  ctx: CommandContext,
  fixture: string | null,
  fn: (fixture: string) => ExitCode,
): ExitCode => {
  if (fixture === null) {
    emitHuman(ctx.writer, `--fixture is required; one of: ${QUICKSTART_SCENARIOS.join(', ')}`);
    if (ctx.json)
      emitJson(ctx.writer, 'error', { error: 'missing-fixture', exitCode: EXIT.invalidConfig });
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
      if (ctx.json)
        emitJson(ctx.writer, 'evidence verify', {
          error: 'missing-file',
          exitCode: EXIT.invalidConfig,
        });
      return EXIT.invalidConfig;
    }
    const read = options.readBundle ?? defaultReadBundle;
    const bundle = read(args.file);
    return evidenceVerify(ctx, bundle, args.fixture);
  }
  emitHuman(ctx.writer, 'usage: evidence <export|verify>');
  if (ctx.json)
    emitJson(ctx.writer, 'evidence', { error: 'invalid-subcommand', exitCode: EXIT.invalidConfig });
  return EXIT.invalidConfig;
};

const defaultReadBundle = (path: string): EvidenceBundle =>
  JSON.parse(readFileSync(path, 'utf8')) as EvidenceBundle;

export { HELP };
