import { type GlobalVerdict } from '@ictt-sentinel/invariant-core';

/**
 * Exit code contract.
 *
 * ONLY an overall OK is zero. Everything else gets a distinct non-zero code,
 * because a CI job that cannot tell "we proved a breach" from "we could not read
 * the chain" from "your config is wrong" will treat all three the same way, and
 * they need opposite responses.
 *
 * These are part of the public API: changing one silently breaks every pipeline
 * that branches on them.
 */
export const EXIT = {
  /** Every required control complete, fresh and passing. */
  ok: 0,
  /** Reserved: a shell uses 1 for generic failure, so nothing here claims it. */
  reserved: 1,
  /** Deterministic breach with sufficient evidence. An incident. */
  critical: 2,
  /** A required control could not be established. A blind spot, not an incident. */
  requiredUnknown: 3,
  /** Policy or liveness deviation, nothing stronger behind it. */
  warn: 4,
  /** Manifest, policy or arguments are invalid. Nothing was evaluated. */
  invalidConfig: 5,
  /** The tool itself failed. Never reported as a verdict. */
  internalError: 6,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export const exitCodeForVerdict = (v: GlobalVerdict): ExitCode => {
  switch (v.protocolStatus) {
    case 'OK':
      return EXIT.ok;
    case 'CRITICAL':
      return EXIT.critical;
    case 'UNKNOWN':
      return EXIT.requiredUnknown;
    case 'WARN':
      return EXIT.warn;
  }
};

/** Human-readable meaning, used by `--help` and by the docs table. */
export const EXIT_MEANING: Readonly<Record<number, string>> = {
  0: 'OK - every required control complete, fresh and passing',
  2: 'CRITICAL - deterministic breach observed with sufficient evidence',
  3: 'UNKNOWN - a required control could not be established',
  4: 'WARN - policy or liveness deviation',
  5: 'invalid configuration or arguments; nothing was evaluated',
  6: 'internal error in the tool itself',
};
