import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiFailure } from '../src/api/client.js';
import { FORBIDDEN_CLAIMS } from '../src/model/claim.js';
import { deriveIncidents } from '../src/model/incidents.js';
import {
  empty,
  failed,
  loading,
  notConfigured,
  ready,
  SLOW_AFTER_MS,
} from '../src/model/screen.js';
import { CoveragePage } from '../src/ui/pages/coverage.js';
import { DeploymentsPage } from '../src/ui/pages/deployments.js';
import { EvidenceDetailPage, EvidenceListPage } from '../src/ui/pages/evidence.js';
import { IncidentsPage } from '../src/ui/pages/incidents.js';
import { MessagesPage } from '../src/ui/pages/messages.js';
import { OnboardingPage } from '../src/ui/pages/onboarding.js';
import { OverviewPage } from '../src/ui/pages/overview.js';
import { bundleFixture, messageFixture, NOW, recordFixture, statusFixture } from './fixtures.js';

/**
 * Rendered-state coverage.
 *
 * Every screen is rendered in every designed state and snapshotted. The
 * snapshots are the cheap part; the assertions after them are the point:
 *
 *   - nothing that is not reconciled and fresh ever renders the healthy tone;
 *   - no screen emits a claim the product may not make;
 *   - attacker-controlled contract metadata comes out inert.
 */

const html = (element: ReactElement): string => renderToStaticMarkup(element);

const grant = {
  deploymentId: 'acme-usdc',
  tenantId: 'tenant-a',
  sharingLevel: 'approved-full' as const,
};
const failure = new ApiFailure('network', 'The API could not be reached.', 'Try again later.');

/** Every screen, in every state, as one addressable table. */
const SCREENS: readonly (readonly [string, ReactElement])[] = [
  ['deployments/loading', <DeploymentsPage state={loading(0)} nowMs={NOW} />],
  ['deployments/loading-slow', <DeploymentsPage state={loading(SLOW_AFTER_MS + 1)} nowMs={NOW} />],
  [
    'deployments/not-configured',
    <DeploymentsPage
      state={notConfigured('No token entered.', 'Enter a token above.')}
      nowMs={NOW}
    />,
  ],
  [
    'deployments/empty',
    <DeploymentsPage
      state={empty('No deployments granted.', 'Ask an operator for a grant.')}
      nowMs={NOW}
    />,
  ],
  ['deployments/failed', <DeploymentsPage state={failed(failure)} nowMs={NOW} />],
  [
    'deployments/healthy',
    <DeploymentsPage
      state={ready([{ grant, status: statusFixture(), chains: null }])}
      nowMs={NOW}
    />,
  ],
  [
    'deployments/warn',
    <DeploymentsPage
      state={ready([
        {
          grant,
          status: statusFixture({ currentProtocolStatus: 'WARN', protocolStatus: 'WARN' }),
          chains: null,
        },
      ])}
      nowMs={NOW}
    />,
  ],
  [
    'deployments/critical',
    <DeploymentsPage
      state={ready([
        {
          grant,
          status: statusFixture({ currentProtocolStatus: 'CRITICAL', protocolStatus: 'CRITICAL' }),
          chains: null,
        },
      ])}
      nowMs={NOW}
    />,
  ],
  [
    'deployments/unknown',
    <DeploymentsPage
      state={ready([
        {
          grant,
          status: statusFixture({ currentProtocolStatus: 'UNKNOWN', protocolStatus: 'UNKNOWN' }),
          chains: null,
        },
      ])}
      nowMs={NOW}
    />,
  ],
  [
    'deployments/stale',
    <DeploymentsPage
      state={ready([
        {
          grant,
          status: statusFixture({
            stale: true,
            currentProtocolStatus: 'UNKNOWN',
            currentDataStatus: 'STALE',
          }),
          chains: null,
        },
      ])}
      nowMs={NOW}
    />,
  ],
  [
    'deployments/no-evaluation',
    <DeploymentsPage state={ready([{ grant, status: null, chains: null }])} nowMs={NOW} />,
  ],

  [
    'overview/healthy',
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
    'overview/split-brain',
    <OverviewPage
      state={ready({
        status: statusFixture({ currentDataStatus: 'DIVERGENT', dataStatus: 'DIVERGENT' }),
        bundle: bundleFixture({ divergent: true }),
        sharingLevel: 'approved-full',
      })}
      nowMs={NOW}
    />,
  ],
  [
    'overview/incomplete-census',
    <OverviewPage
      state={ready({
        status: statusFixture(),
        bundle: bundleFixture({ missingRemotes: [`0x${'9'.repeat(40)}`] }),
        sharingLevel: 'approved-full',
      })}
      nowMs={NOW}
    />,
  ],
  [
    'overview/unsupported-adapter',
    <OverviewPage
      state={ready({
        status: statusFixture(),
        bundle: bundleFixture({ claimMode: 'UNSUPPORTED' }),
        sharingLevel: 'approved-full',
      })}
      nowMs={NOW}
    />,
  ],
  [
    'overview/sanitized-metadata',
    <OverviewPage
      state={ready({
        status: statusFixture({ sharingLevel: 'sanitized-metadata' }),
        bundle: null,
        sharingLevel: 'sanitized-metadata',
      })}
      nowMs={NOW}
    />,
  ],
  ['overview/failed', <OverviewPage state={failed(failure)} nowMs={NOW} />],

  [
    'coverage/canonical-erc20',
    <CoveragePage state={ready({ bundle: bundleFixture(), sharingLevel: 'approved-full' })} />,
  ],
  [
    'coverage/native-upper-bound',
    <CoveragePage
      state={ready({ bundle: bundleFixture({ native: true }), sharingLevel: 'approved-full' })}
    />,
  ],
  [
    'coverage/native-indeterminate',
    <CoveragePage
      state={ready({
        bundle: bundleFixture({ native: true, claimMode: 'INDETERMINATE', coverage: 'PARTIAL' }),
        sharingLevel: 'approved-full',
      })}
    />,
  ],
  [
    'coverage/not-shared',
    <CoveragePage state={ready({ bundle: null, sharingLevel: 'sanitized-metadata' })} />,
  ],
  ['coverage/loading', <CoveragePage state={loading(0)} />],

  [
    'messages/delivered-and-retried',
    <MessagesPage state={ready([messageFixture()])} deploymentId="acme-usdc" />,
  ],
  [
    'messages/unsupported-state',
    <MessagesPage
      state={ready([messageFixture({ state: 'unsupported', timeline: [] })])}
      deploymentId="acme-usdc"
    />,
  ],
  ['messages/empty', <MessagesPage state={ready([])} deploymentId="acme-usdc" />],

  [
    'incidents/open-and-recovered',
    <IncidentsPage
      state={ready(
        deriveIncidents([
          recordFixture('5'.repeat(64), 'UNKNOWN', 'PARTIAL', '2026-06-01T11:00:00.000Z'),
          recordFixture('4'.repeat(64), 'OK', 'COMPLETE', '2026-06-01T10:00:00.000Z'),
          recordFixture('3'.repeat(64), 'CRITICAL', 'COMPLETE', '2026-06-01T09:00:00.000Z'),
          recordFixture('2'.repeat(64), 'WARN', 'COMPLETE', '2026-06-01T08:00:00.000Z'),
        ]),
      )}
      deploymentId="acme-usdc"
      nowMs={NOW}
    />,
  ],
  ['incidents/none', <IncidentsPage state={ready([])} deploymentId="acme-usdc" nowMs={NOW} />],

  [
    'evidence/list',
    <EvidenceListPage
      state={ready([recordFixture('a'.repeat(64)), recordFixture('b'.repeat(64), 'CRITICAL')])}
      deploymentId="acme-usdc"
      nowMs={NOW}
    />,
  ],
  [
    'evidence/detail-full',
    <EvidenceDetailPage
      state={ready({
        schemaVersion: '',
        metadata: recordFixture('a'.repeat(64)),
        bundle: bundleFixture(),
      })}
    />,
  ],
  [
    'evidence/detail-metadata-only',
    <EvidenceDetailPage
      state={ready({
        schemaVersion: '',
        metadata: {
          ...recordFixture('a'.repeat(64)),
          sharingLevel: 'sanitized-metadata',
          verifyStatus: 'metadata-only',
        },
        bundle: null,
      })}
    />,
  ],

  ['onboarding/initial', <OnboardingPage />],
];

describe('every screen state', () => {
  it.each(SCREENS)('renders %s', (_name, element) => {
    expect(html(element)).toMatchSnapshot();
  });

  it('never labels an unresolved screen with the reconciled protocol wording', () => {
    // `data-tone="ok"` on its own is not the property: a CRITICAL protocol status
    // beside a COMPLETE data status legitimately renders one healthy badge, and
    // keeping those two independent is the point. What must never appear on an
    // unresolved screen is the PROTOCOL-healthy label.
    const unresolved = SCREENS.filter(
      ([name]) =>
        name.includes('unknown') ||
        name.includes('stale') ||
        name.includes('split-brain') ||
        name.includes('unsupported') ||
        name.includes('incomplete') ||
        name.includes('failed') ||
        name.includes('loading') ||
        name.includes('critical'),
    );
    expect(unresolved.length).toBeGreaterThan(8);
    for (const [name, element] of unresolved) {
      const markup = html(element);
      expect(markup, `${name} claims a reconciled protocol status`).not.toContain(
        '<span>Reconciled</span>',
      );
      expect(markup, `${name} claims the healthy condition`).not.toContain(
        'Reconciled at the pinned blocks',
      );
    }
  });

  it('shows a reason and a remedy on every screen that cannot show data', () => {
    for (const [name, element] of SCREENS) {
      if (!/loading|not-configured|empty|failed/.test(name)) continue;
      const markup = html(element);
      expect(markup, `${name} has no state block`).toContain('class="state"');
      // A spinner with no explanation is the failure this asserts against.
      expect(markup.length, `${name} renders nothing useful`).toBeGreaterThan(200);
    }
  });

  it('emits no unqualified forbidden claim on any screen in any state', () => {
    // A negated mention is the correct language - "not a cryptographic or
    // Byzantine guarantee" is a disclaimer, not a claim - so the check looks at
    // the clause around each match rather than at the word alone.
    const negated = (clause: string): boolean =>
      /\b(?:not|never|no|cannot|without|nor|neither)\b/i.test(clause);
    for (const [name, element] of SCREENS) {
      const text = html(element).replace(/<[^>]*>/g, ' ');
      for (const rx of FORBIDDEN_CLAIMS) {
        const scan = new RegExp(rx.source, `${rx.flags.replace('g', '')}g`);
        for (const match of text.matchAll(scan)) {
          const from = Math.max(0, match.index - 120);
          const clause = text.slice(from, match.index);
          expect(negated(clause), `${name} claims "${match[0]}" without qualification`).toBe(true);
        }
      }
    }
  });

  it('offers no wallet, signer or chain action control anywhere', () => {
    // Scoped to interactive controls: the onboarding page must be able to say
    // "this console approves nothing" without the word tripping the check.
    const controls = /<(?:button|a|input|form)\b[^>]*>(?:[^<]*)/gi;
    const forbidden = [
      /connect wallet/i,
      /\bsign\b/i,
      /send transaction/i,
      /\bapprove\b/i,
      /\bpause\b/i,
      /\bmint\b/i,
      /\bburn\b/i,
      /\bretry\b/i,
    ];
    for (const [name, element] of SCREENS) {
      const markup = html(element);
      expect(markup, `${name} touches an injected wallet`).not.toContain('window.ethereum');
      for (const control of markup.match(controls) ?? []) {
        for (const rx of forbidden) {
          expect(rx.test(control), `${name} exposes a control matching ${rx.source}`).toBe(false);
        }
      }
    }
  });

  it('uses no raw-HTML escape hatch anywhere in the console', () => {
    // The one API that could defeat React's escaping is not used anywhere. The
    // `=` matters: the prose in primitives.tsx names the API in order to rule it
    // out, and a checker that cannot tell prose from a call site is a checker
    // nobody keeps. Lives here rather than in the DOM test because that file
    // runs in happy-dom, where `import.meta.url` is not a file URL.
    const root = fileURLToPath(new URL('../src', import.meta.url));
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry);
        return statSync(full).isDirectory() ? walk(full) : [full];
      });
    const offenders = walk(root)
      .filter((f) => /\.tsx?$/.test(f))
      .filter((f) => /dangerouslySetInnerHTML\s*=/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
