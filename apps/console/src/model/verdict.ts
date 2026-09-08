import type { DataStatus, DeploymentStatus, ProtocolStatus } from '../api/contract.js';

/**
 * How a verdict is presented.
 *
 * The rules here are the ones the product is judged on, so they live in a pure
 * module with tests rather than inside a component:
 *
 *   1. `UNKNOWN`, stale and split-brain are NEVER the healthy tone. Not a paler
 *      green, not a green with a warning icon - a different tone entirely.
 *   2. `CRITICAL` and `UNKNOWN` differ in tone, icon AND wording. They demand
 *      opposite responses: one is "we proved a breach", the other is "we could
 *      not see". An operator who confuses them wastes the incident.
 *   3. Colour is never the only carrier. Every badge is a tone plus a glyph plus
 *      a text label, so the screen survives greyscale, colour blindness and a
 *      screen reader.
 *   4. There is no aggregate "security score". Evidence classes are reported
 *      separately because they are separately actionable (docs/INVARIANTS.md).
 */

/** Semantic tone tokens. Components map these to CSS variables, never to hex. */
export const TONES = ['ok', 'warn', 'critical', 'unknown', 'neutral'] as const;
export type Tone = (typeof TONES)[number];

export interface Badge {
  readonly tone: Tone;
  /** Short label. Carries the meaning on its own, without the colour. */
  readonly label: string;
  /** Text glyph, decorative in the DOM; `label` is the accessible name. */
  readonly glyph: string;
  /** One sentence an operator can act on. */
  readonly meaning: string;
}

const PROTOCOL: Readonly<Record<ProtocolStatus, Badge>> = {
  OK: {
    tone: 'ok',
    label: 'Reconciled',
    glyph: '✓',
    meaning: 'Observed onchain coverage reconciled at the pinned blocks.',
  },
  WARN: {
    tone: 'warn',
    label: 'Deviation',
    glyph: '!',
    meaning: 'Policy or liveness deviation observed. This is not evidence of an economic breach.',
  },
  UNKNOWN: {
    tone: 'unknown',
    label: 'Not established',
    glyph: '?',
    meaning:
      'The evidence does not decide this either way. Unresolved, and never the same as healthy.',
  },
  CRITICAL: {
    tone: 'critical',
    label: 'Breach observed',
    glyph: '✕',
    meaning: 'Deterministic accounting breach observed with sufficient evidence at pinned blocks.',
  },
};

/**
 * Data status.
 *
 * Reported next to protocol status, never merged into it. "The bridge is fine"
 * and "we could read the chain" are different claims, and collapsing them is how
 * a monitoring gap becomes a green dashboard (docs/adr/0003-fail-closed-verdicts.md).
 */
const DATA: Readonly<Record<DataStatus, Badge>> = {
  COMPLETE: {
    tone: 'ok',
    label: 'Complete',
    glyph: '✓',
    meaning: 'Every required observation was collected within its freshness window.',
  },
  STALE: {
    tone: 'unknown',
    label: 'Stale',
    glyph: '⌛',
    meaning: 'No fresh observation. What is shown describes the past, not now.',
  },
  PARTIAL: {
    tone: 'unknown',
    label: 'Partial',
    glyph: '◐',
    meaning: 'Some required evidence is missing, so coverage is incomplete.',
  },
  DIVERGENT: {
    tone: 'critical',
    label: 'Witnesses disagree',
    glyph: '⇄',
    meaning:
      'Independent providers reported different history. This is a data fault, not a tiebreak.',
  },
  UNKNOWN: {
    tone: 'unknown',
    label: 'Not established',
    glyph: '?',
    meaning: 'The state of the evidence itself could not be established.',
  },
};

export const protocolBadge = (status: ProtocolStatus): Badge => PROTOCOL[status];
export const dataBadge = (status: DataStatus): Badge => DATA[status];

/**
 * The badge pair for a status row.
 *
 * Reads `currentProtocolStatus` / `currentDataStatus`, which the API has already
 * degraded for age. Reading the raw fields here would reintroduce exactly the
 * stale-green bug the server takes care to prevent.
 */
export interface StatusView {
  /** What the screen shows. Qualified when the data underneath is not sound. */
  readonly protocol: Badge;
  /** What the API reported, before qualification. Shown in the detail row. */
  readonly rawProtocol: Badge;
  readonly data: Badge;
  readonly stale: boolean;
  /** Present when the protocol badge was qualified, saying why. */
  readonly qualifier: string | null;
  /** Extra line shown when the record is past its freshness window. */
  readonly staleNotice: string | null;
}

/**
 * Data statuses that make a protocol result unusable.
 *
 * A protocol status is a conclusion drawn FROM the data. When independent
 * witnesses disagreed, or the window was partial, or nothing fresh arrived, an
 * `OK` conclusion was drawn from evidence that does not support it - so it is
 * not shown as healthy, whatever the field says.
 *
 * The reported value is not hidden: it stays in the detail row and in the API
 * response. What changes is that the screen refuses to paint it green.
 */
const UNSOUND: Readonly<Record<DataStatus, boolean>> = {
  COMPLETE: false,
  STALE: true,
  PARTIAL: true,
  DIVERGENT: true,
  UNKNOWN: true,
};

const QUALIFIED: Badge = {
  tone: 'unknown',
  label: 'Not relied upon',
  glyph: '?',
  meaning:
    'A protocol result was reported, but the evidence underneath it is not sound, so it is not presented as a healthy verdict.',
};

/**
 * @param evidenceSound  What the rest of the page knows. A screen that also has
 *   the bundle can see things the status fields do not carry - an incomplete
 *   census, a shape this build cannot interpret - and passes `false`. A screen
 *   with only the status fields passes nothing and gets the data-status rule
 *   alone, which is all it honestly has.
 */
export const statusView = (status: DeploymentStatus, evidenceSound = true): StatusView => {
  const raw = protocolBadge(status.currentProtocolStatus);
  const unsoundData = UNSOUND[status.currentDataStatus];
  // A proven breach is never softened: CRITICAL stands whatever the data says.
  const qualify = (unsoundData || !evidenceSound) && status.currentProtocolStatus !== 'CRITICAL';
  return {
    protocol: qualify ? QUALIFIED : raw,
    rawProtocol: raw,
    data: dataBadge(status.currentDataStatus),
    stale: status.stale,
    qualifier: qualify
      ? unsoundData
        ? `Reported as ${status.currentProtocolStatus}, but the data status is ${status.currentDataStatus}. A conclusion drawn from evidence that is not sound is not shown as healthy.`
        : `Reported as ${status.currentProtocolStatus}, but the evidence on this page does not support a healthy reading. See the panel above.`
      : null,
    staleNotice: status.stale
      ? 'This evaluation is past its freshness window. It has been degraded and is not a current health claim.'
      : null,
  };
};

/**
 * Whether a tone may be rendered as healthy.
 *
 * A single predicate so no component can invent its own. Asserted by test
 * against every status value in the contract, which is what makes "UNKNOWN is
 * never green" a checked property rather than a convention.
 */
export const isHealthyTone = (tone: Tone): boolean => tone === 'ok';

/** No deployment gets one number. Evidence classes stay separate on purpose. */
export const AGGREGATE_SCORE_IS_NOT_PROVIDED =
  'This product reports evidence classes, not a single security score: a breach and a blind spot need opposite responses.' as const;
