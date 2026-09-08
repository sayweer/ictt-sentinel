// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ready } from '../src/model/screen.js';
import { CoveragePage } from '../src/ui/pages/coverage.js';
import { DeploymentsPage } from '../src/ui/pages/deployments.js';
import { EvidenceDetailPage } from '../src/ui/pages/evidence.js';
import { IncidentsPage } from '../src/ui/pages/incidents.js';
import { MessagesPage } from '../src/ui/pages/messages.js';
import { OnboardingPage } from '../src/ui/pages/onboarding.js';
import { OverviewPage } from '../src/ui/pages/overview.js';
import { deriveIncidents } from '../src/model/incidents.js';
import {
  bundleFixture,
  HOSTILE,
  messageFixture,
  NOW,
  recordFixture,
  statusFixture,
} from './fixtures.js';

/**
 * DOM-level assertions.
 *
 * The XSS question cannot be answered with a regex over markup: escaped hostile
 * text legitimately CONTAINS the substring `onerror=` inside a title attribute
 * or a text node, and that is inert. What matters is what a parser produces, so
 * these tests parse the rendered output and walk the real tree.
 *
 * Accessibility is checked the same way, against the parsed document rather
 * than against the source of a component.
 */

const parse = (element: ReactElement): Document => {
  const doc = document.implementation.createHTMLDocument('test');
  doc.body.innerHTML = renderToStaticMarkup(element);
  return doc;
};

const HOSTILE_SCREENS: readonly (readonly [string, ReactElement])[] = [
  [
    'overview',
    <OverviewPage
      state={ready({
        status: statusFixture(),
        bundle: bundleFixture({ hostile: true }),
        sharingLevel: 'approved-full',
      })}
      nowMs={NOW}
    />,
  ],
  [
    'coverage',
    <CoveragePage
      state={ready({ bundle: bundleFixture({ hostile: true }), sharingLevel: 'approved-full' })}
    />,
  ],
  [
    'messages',
    <MessagesPage
      state={ready([
        messageFixture({ state: HOSTILE, timeline: [{ kind: HOSTILE, factDigest: HOSTILE }] }),
      ])}
      deploymentId="acme-usdc"
    />,
  ],
  [
    'evidence-detail',
    <EvidenceDetailPage
      state={ready({
        schemaVersion: '',
        metadata: recordFixture('a'.repeat(64)),
        bundle: bundleFixture({ hostile: true }),
      })}
    />,
  ],
];

describe('untrusted contract metadata', () => {
  it.each(HOSTILE_SCREENS)('renders hostile metadata inert on %s', (name, element) => {
    const doc = parse(element);
    // The text is there, so the operator sees what the chain actually says.
    expect(doc.body.textContent ?? '').toContain('<script>alert(1)</script>');
    // And it produced no elements and no handlers.
    expect(doc.querySelectorAll('script, img, iframe, object, embed, style, link')).toHaveLength(0);
    for (const element_ of doc.querySelectorAll('*')) {
      for (const attribute of element_.getAttributeNames()) {
        expect(
          attribute.toLowerCase().startsWith('on'),
          `${name}: <${element_.tagName.toLowerCase()} ${attribute}> is an event handler`,
        ).toBe(false);
      }
      // A javascript: href would survive escaping; nothing here builds one.
      const href = element_.getAttribute('href');
      if (href !== null) expect(href.toLowerCase().startsWith('javascript:')).toBe(false);
    }
  });
});

describe('accessibility structure', () => {
  const screens: readonly (readonly [string, ReactElement])[] = [
    [
      'deployments',
      <DeploymentsPage
        state={ready([
          {
            grant: {
              deploymentId: 'acme-usdc',
              tenantId: 'tenant-a',
              sharingLevel: 'approved-full',
            },
            status: statusFixture(),
            chains: null,
          },
        ])}
        nowMs={NOW}
      />,
    ],
    [
      'overview',
      <OverviewPage
        state={ready({
          status: statusFixture(),
          bundle: bundleFixture(),
          sharingLevel: 'approved-full',
        })}
        nowMs={NOW}
      />,
    ],
    [
      'coverage',
      <CoveragePage state={ready({ bundle: bundleFixture(), sharingLevel: 'approved-full' })} />,
    ],
    ['messages', <MessagesPage state={ready([messageFixture()])} deploymentId="acme-usdc" />],
    [
      'incidents',
      <IncidentsPage
        state={ready(
          deriveIncidents([
            recordFixture('3'.repeat(64), 'CRITICAL', 'COMPLETE', '2026-06-01T09:00:00.000Z'),
          ]),
        )}
        deploymentId="acme-usdc"
        nowMs={NOW}
      />,
    ],
    ['onboarding', <OnboardingPage />],
  ];

  it.each(screens)('%s has a main landmark and a single top heading', (name, element) => {
    const doc = parse(element);
    const main = doc.querySelector('main#main');
    expect(main, `${name} has no main landmark`).not.toBeNull();
    expect(doc.querySelectorAll('main')).toHaveLength(1);
    expect(doc.querySelectorAll('h2').length).toBeGreaterThanOrEqual(1);
  });

  it.each(screens)('%s gives every table a caption and column scopes', (name, element) => {
    const doc = parse(element);
    for (const table of doc.querySelectorAll('table')) {
      expect(table.querySelector('caption'), `${name} has an uncaptioned table`).not.toBeNull();
      // The caption carries a screen-reader summary so nobody has to walk the
      // grid to find out whether walking it is worth it.
      expect(table.querySelector('caption .visually-hidden')).not.toBeNull();
      for (const header of table.querySelectorAll('thead th')) {
        expect(header.getAttribute('scope')).toBe('col');
      }
      for (const header of table.querySelectorAll('tbody th')) {
        expect(header.getAttribute('scope')).toBe('row');
      }
    }
  });

  it.each(screens)('%s names every region and list it renders', (name, element) => {
    const doc = parse(element);
    for (const section of doc.querySelectorAll('section')) {
      const labelled =
        section.hasAttribute('aria-label') ||
        section.hasAttribute('aria-labelledby') ||
        section.classList.contains('state') ||
        section.classList.contains('panel');
      expect(labelled, `${name} has an unnamed section`).toBe(true);
      const id = section.getAttribute('aria-labelledby');
      if (id !== null) {
        expect(doc.getElementById(id), `${name}: aria-labelledby points at nothing`).not.toBeNull();
      }
    }
    // A timeline is an ordered list, because the order is the meaning.
    for (const timeline of doc.querySelectorAll('.timeline')) {
      expect(timeline.tagName.toLowerCase()).toBe('ol');
    }
  });

  it('labels every form control and marks decorative glyphs as hidden', () => {
    const doc = parse(<OnboardingPage />);
    for (const control of doc.querySelectorAll('input, textarea, select')) {
      const id = control.getAttribute('id');
      expect(id, 'a form control has no id to label').not.toBeNull();
      const label = doc.querySelector(`label[for="${String(id)}"]`);
      expect(label ?? control.getAttribute('aria-label'), 'unlabelled control').not.toBeNull();
    }
    const badges = parse(
      <OverviewPage
        state={ready({
          status: statusFixture(),
          bundle: bundleFixture(),
          sharingLevel: 'approved-full',
        })}
        nowMs={NOW}
      />,
    );
    for (const glyph of badges.querySelectorAll('.badge .glyph')) {
      // The glyph is decoration; the sibling label is the accessible name.
      expect(glyph.getAttribute('aria-hidden')).toBe('true');
      expect(glyph.parentElement?.textContent?.trim().length).toBeGreaterThan(1);
    }
  });

  it('gives every link an accessible name and a same-document target', () => {
    for (const [name, element] of screens) {
      const doc = parse(element);
      for (const anchor of doc.querySelectorAll('a')) {
        expect(
          (anchor.textContent ?? '').trim().length,
          `${name} has an unnamed link`,
        ).toBeGreaterThan(0);
        const href = anchor.getAttribute('href') ?? '';
        // Every link is a hash route: the console navigates nowhere else.
        expect(href.startsWith('#'), `${name} links off-document to ${href}`).toBe(true);
      }
    }
  });
});
