import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AA_LARGE, AA_TEXT, DARK, LIGHT, contrastRatio, type Palette } from '../src/ui/tokens.js';
import { TONES } from '../src/model/verdict.js';

const CSS = readFileSync(fileURLToPath(new URL('../src/ui/styles.css', import.meta.url)), 'utf8');

const themes: readonly (readonly [string, Palette])[] = [
  ['light', LIGHT],
  ['dark', DARK],
];

describe('design tokens', () => {
  it.each(themes)('%s theme clears WCAG AA for every text pair', (_name, palette) => {
    for (const ground of [palette.background, palette.surface]) {
      expect(contrastRatio(palette.text, ground)).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrastRatio(palette.muted, ground)).toBeGreaterThanOrEqual(AA_TEXT);
      for (const tone of TONES) {
        expect(contrastRatio(palette.tone[tone], ground)).toBeGreaterThanOrEqual(AA_TEXT);
      }
    }
    // A badge is coloured text on a tinted ground; both readings must clear AA.
    for (const tone of TONES) {
      expect(contrastRatio(palette.tone[tone], palette.toneSurface[tone])).toBeGreaterThanOrEqual(
        AA_TEXT,
      );
      expect(contrastRatio(palette.text, palette.toneSurface[tone])).toBeGreaterThanOrEqual(
        AA_TEXT,
      );
    }
    // Component boundaries and the focus ring are non-text UI, so 3:1 applies.
    expect(contrastRatio(palette.border, palette.background)).toBeGreaterThanOrEqual(AA_LARGE);
    expect(contrastRatio(palette.border, palette.surface)).toBeGreaterThanOrEqual(AA_LARGE);
    expect(contrastRatio(palette.focus, palette.background)).toBeGreaterThanOrEqual(AA_LARGE);
  });

  it('keeps every tone visually distinguishable from every other', () => {
    for (const palette of [LIGHT, DARK]) {
      for (const a of TONES) {
        for (const b of TONES) {
          if (a === b) continue;
          expect(palette.tone[a]).not.toBe(palette.tone[b]);
        }
      }
    }
  });

  it('mirrors the token values in the stylesheet so the two cannot drift', () => {
    const variable = (name: string, value: string): void => {
      expect(CSS).toContain(`${name}: ${value};`);
    };
    for (const [, palette] of themes) {
      variable('--bg', palette.background);
      variable('--surface', palette.surface);
      variable('--text', palette.text);
      variable('--muted', palette.muted);
      variable('--border', palette.border);
      variable('--focus', palette.focus);
      for (const tone of TONES) {
        variable(`--tone-${tone}`, palette.tone[tone]);
        variable(`--tone-surface-${tone}`, palette.toneSurface[tone]);
      }
    }
  });

  it('honours reduced motion and never removes the focus indicator', () => {
    expect(CSS).toContain('@media (prefers-reduced-motion: reduce)');
    expect(CSS).toContain(':focus-visible');
    expect(CSS).toContain('outline: 3px solid var(--focus)');
    // `outline: none` anywhere would strip the only keyboard affordance there is.
    expect(CSS).not.toMatch(/outline:\s*(none|0)\b/);
  });

  it('declares a dark theme that redefines the same token set', () => {
    expect(CSS).toContain('@media (prefers-color-scheme: dark)');
    expect(CSS).toContain('color-scheme: light dark');
  });

  it('reflows rather than forcing a horizontal scroll on a narrow viewport', () => {
    expect(CSS).toContain('@media (max-width: 720px)');
    // Wide content scrolls inside its own container, never the page body.
    expect(CSS).toContain('.scroll-x');
    expect(CSS).toContain('overflow-x: auto');
  });
});
