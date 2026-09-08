import type { Tone } from '../model/verdict.js';

/**
 * Design tokens.
 *
 * Semantic names only. A component asks for `tone-critical`, never for a hex
 * value, so a theme change cannot silently turn one meaning into another.
 *
 * These values are the source of truth and `styles.css` mirrors them; a test
 * asserts the two agree and that every foreground/background pair clears WCAG
 * AA. Colour is never the only carrier of meaning anywhere in this console -
 * every tone is rendered with a glyph and a text label as well - but a palette
 * that fails contrast still fails operators with low vision, so it is gated.
 */

export interface Palette {
  readonly background: string;
  readonly surface: string;
  readonly text: string;
  readonly muted: string;
  readonly border: string;
  readonly focus: string;
  readonly tone: Readonly<Record<Tone, string>>;
  /** Tint behind a tone badge. Text on it must still clear AA. */
  readonly toneSurface: Readonly<Record<Tone, string>>;
}

export const LIGHT: Palette = {
  background: '#ffffff',
  surface: '#f4f6f8',
  text: '#15181c',
  muted: '#454b53',
  border: '#7f868e',
  focus: '#0b4fb3',
  tone: {
    ok: '#0a6b3d',
    warn: '#7a4c00',
    critical: '#a4161a',
    unknown: '#553399',
    neutral: '#454b53',
  },
  toneSurface: {
    ok: '#e6f4ec',
    warn: '#fbf0dd',
    critical: '#fceceb',
    unknown: '#efe9fa',
    neutral: '#eef0f3',
  },
};

export const DARK: Palette = {
  background: '#0e1116',
  surface: '#171c23',
  text: '#e9ecf1',
  muted: '#a8b1bd',
  border: '#657182',
  focus: '#7cb0ff',
  tone: {
    ok: '#5fd39a',
    warn: '#f0b45e',
    critical: '#ff9a92',
    unknown: '#c0abff',
    neutral: '#a8b1bd',
  },
  toneSurface: {
    ok: '#12301f',
    warn: '#33260f',
    critical: '#3a1a19',
    unknown: '#241d3d',
    neutral: '#1f242c',
  },
};

/** sRGB relative luminance, WCAG 2.2 definition. */
export const luminance = (hex: string): number => {
  const value = hex.replace('#', '');
  const channel = (offset: number): number => {
    const raw = Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
    return raw <= 0.03928 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
};

export const contrastRatio = (a: string, b: string): number => {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
};

/** WCAG AA: 4.5:1 for body text, 3:1 for large text and UI component edges. */
export const AA_TEXT = 4.5;
export const AA_LARGE = 3;
