#!/usr/bin/env node
// @ictt-sentinel/cli
//
// Binary: `ictt-sentinel`. There is deliberately no generic `sentinel` alias:
// a short, generic name on an operator's PATH is a collision waiting to happen.
//
// This process holds no key, sends no transaction and can pause nothing. Every
// command is read-only, and the only thing it writes is an evidence bundle in a
// directory the operator names.

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import { EXIT, type ExitCode } from './exit-codes.js';
import { processWriter } from './output.js';
import { run } from './run.js';

export const PACKAGE_NAME = '@ictt-sentinel/cli' as const;

export { EXIT, EXIT_MEANING, exitCodeForVerdict } from './exit-codes.js';
export type { ExitCode } from './exit-codes.js';
export { JSON_SCHEMA_VERSION, emitHuman, emitJson, processWriter } from './output.js';
export type { Writer } from './output.js';
export { BINARY, HELP, parseArgs, run } from './run.js';
export type { RunOptions } from './run.js';
export { writeAtomic, resolveEvidencePath, UnsafeEvidencePathError } from './atomic-write.js';
export {
  check,
  discover,
  doctor,
  evidenceExport,
  evidenceVerify,
  init,
  recomputeHash,
  replay,
} from './commands.js';
export type { CommandContext, CheckResult } from './commands.js';

/** Build identity. Kept in one place so `--version` and evidence agree. */
export const VERSION = '0.0.0' as const;

const isDirectRun = (): boolean => {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(realpathSync(entry)).href === import.meta.url;
};

if (isDirectRun()) {
  // Cancellation sets the exit code and lets the process unwind normally. No
  // command performs a partial write that a signal could strand: evidence is
  // written atomically or not at all.
  const cancellation = new AbortController();
  const onCancel = (): void => {
    cancellation.abort();
    process.exitCode = EXIT.internalError;
  };
  process.once('SIGINT', onCancel);
  process.once('SIGTERM', onCancel);

  await setImmediate();
  const code: ExitCode = cancellation.signal.aborted
    ? EXIT.internalError
    : run({
        argv: process.argv.slice(2),
        writer: processWriter,
        env: process.env,
        evidenceDir: `${process.cwd()}/evidence-out`,
        version: VERSION,
        isTty: process.stderr.isTTY,
      });
  await setImmediate();
  process.exitCode = cancellation.signal.aborted ? EXIT.internalError : code;
}
