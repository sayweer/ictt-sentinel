/**
 * Formatting.
 *
 * Two rules, both load-bearing:
 *
 *   Amounts never touch `Number`. Token quantities are base-unit integers up to
 *   uint256; a double loses the low bits above 2^53, and a lost base unit is a
 *   wrong verdict (CLAUDE.md 4). Everything here works on strings and `bigint`.
 *
 *   Times are UTC, labelled as UTC. A dashboard that silently renders local time
 *   makes two operators in two offices disagree about when an incident started,
 *   and pinned-block evidence has no local time.
 */

export class AmountFormatError extends Error {
  override readonly name = 'AmountFormatError';
}

const DIGITS = /^(0|[1-9][0-9]*)$/;

/**
 * Digit group separator.
 *
 * Written as an escape and asserted by test. A plain ASCII space, deliberately:
 * a typographic thin space looks better and breaks the moment an operator copies
 * a base-unit figure into anything that parses numbers, and this console exists
 * to move exact integers between a screen and a runbook.
 */
export const DIGIT_SEPARATOR = '\u0020';

/** Group an integer digit string in threes, from the right. */
const group = (digits: string): string => {
  let out = '';
  for (let i = digits.length; i > 0; i -= 3) {
    const start = Math.max(0, i - 3);
    out = digits.slice(start, i) + (out === '' ? '' : `${DIGIT_SEPARATOR}${out}`);
  }
  return out;
};

/**
 * Render a base-unit amount at a given decimal scale.
 *
 * Pure string and bigint arithmetic. The fractional part is cut, never rounded:
 * rounding a token balance for display invites someone to quote the rounded
 * number back as the balance.
 */
export const formatAmount = (
  baseUnits: string | bigint,
  decimals: number,
  maxFractionDigits = 6,
): string => {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new AmountFormatError(`decimals out of range: ${String(decimals)}`);
  }
  const raw = typeof baseUnits === 'bigint' ? baseUnits.toString(10) : baseUnits;
  const negative = raw.startsWith('-');
  const magnitude = negative ? raw.slice(1) : raw;
  if (!DIGITS.test(magnitude)) {
    throw new AmountFormatError(`not a canonical base-unit integer: ${JSON.stringify(raw)}`);
  }
  const padded = magnitude.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = decimals === 0 ? '' : padded.slice(padded.length - decimals);
  const shown = fraction.slice(0, maxFractionDigits).replace(/0+$/, '');
  const truncated =
    fraction.length > maxFractionDigits && /[1-9]/.test(fraction.slice(maxFractionDigits));
  return `${negative ? '-' : ''}${group(whole)}${shown === '' ? '' : `.${shown}`}${truncated ? '…' : ''}`;
};

/** Exact base units, for the drill-down. Grouped, never scaled, never rounded. */
export const formatBaseUnits = (baseUnits: string | bigint): string => {
  const raw = typeof baseUnits === 'bigint' ? baseUnits.toString(10) : baseUnits;
  const negative = raw.startsWith('-');
  const magnitude = negative ? raw.slice(1) : raw;
  if (!DIGITS.test(magnitude)) {
    throw new AmountFormatError(`not a canonical base-unit integer: ${JSON.stringify(raw)}`);
  }
  return `${negative ? '-' : ''}${group(magnitude)}`;
};

/** Block heights are `bigint` too: a chain outlives 2^53 block numbers in theory. */
export const formatBlockNumber = (value: string | bigint): string => formatBaseUnits(value);

/** Middle-elided hash for a table cell. The full value stays in the DOM title. */
export const shortDigest = (digest: string, keep = 8): string =>
  digest.length <= keep * 2 + 1 ? digest : `${digest.slice(0, keep)}…${digest.slice(-keep)}`;

export const TIMEZONE_NOTE = 'All times are UTC.' as const;

/** `2026-06-01 00:00:00 UTC`. Explicit, sortable, unambiguous. */
export const formatInstant = (iso: string): string => {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'unknown time';
  return `${at.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
};

/**
 * Age relative to an injected instant.
 *
 * `now` is a parameter and never `Date.now()`, so a snapshot test of a stale
 * screen produces the same string on every machine and in every year.
 */
export const formatAge = (iso: string, nowMs: number): string => {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 'unknown age';
  const seconds = Math.floor((nowMs - at) / 1000);
  if (seconds < 0) return 'timestamped in the future';
  if (seconds < 60) return `${String(seconds)}s ago`;
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m ago`;
  if (seconds < 86_400) return `${String(Math.floor(seconds / 3600))}h ago`;
  return `${String(Math.floor(seconds / 86_400))}d ago`;
};

/**
 * The viewer's own time zone, stated rather than used.
 *
 * Shown once in the header so an operator can convert if they need to; no
 * timestamp on any screen is rendered in it.
 */
export const viewerTimeZone = (resolved: string | undefined): string =>
  resolved === undefined || resolved === ''
    ? 'unknown local time zone'
    : `Your time zone: ${resolved}`;
