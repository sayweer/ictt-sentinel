import { redact } from '@ictt-sentinel/evidence';

/**
 * Output discipline.
 *
 * Machine JSON goes to stdout and NOTHING else does, so `ictt-sentinel check
 * --json | jq` works without a filter. Every human line, progress indicator and
 * warning goes to stderr. Mixing them is what makes a CLI unusable in a pipeline.
 *
 * Every line is redacted on the way out: an RPC URL in a CI log is a leaked
 * credential, and CI logs are usually more widely readable than the config.
 */

export const JSON_SCHEMA_VERSION = 'ictt-sentinel/cli-output/v1' as const;

export interface Writer {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

export const processWriter: Writer = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

/** Machine output. Stable shape, versioned, stdout only. */
export const emitJson = (w: Writer, command: string, payload: unknown): void => {
  const document = { schemaVersion: JSON_SCHEMA_VERSION, command, ...(payload as object) };
  w.out(`${redact(JSON.stringify(document, null, 2))}\n`);
};

/** Human output. stderr, so it never contaminates a JSON pipe. */
export const emitHuman = (w: Writer, text: string): void => {
  w.err(`${redact(text)}\n`);
};

/** Progress. stderr, and suppressed when not attached to a terminal. */
export const emitProgress = (w: Writer, text: string, isTty: boolean): void => {
  if (!isTty) return;
  w.err(`${redact(text)}\n`);
};
