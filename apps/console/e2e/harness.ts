import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from '@playwright/test';

/**
 * End-to-end harness.
 *
 * Serves the built bundle and a scripted API through Playwright's request
 * interception, so the suite exercises the real artifact in a real browser with
 * no server process anywhere. Two consequences worth stating:
 *
 *   - What is under test is `dist-web`, the file that ships. A development
 *     transform passing is not evidence that the shipped bundle works.
 *   - Every request the page makes is visible here. A request to anything but
 *     the console's own origin fails the test by construction, which is how the
 *     "browser never reaches an RPC endpoint" claim is checked rather than
 *     asserted.
 */

const DIST = fileURLToPath(new URL('../dist-web/', import.meta.url));

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export const TOKEN = 'e2e-token-0123456789abcdef';
export const DEPLOYMENT = 'acme-usdc';
const hex = (c: string, n = 64): string => c.repeat(n);

export interface ApiScript {
  readonly deployments?: unknown;
  readonly status?: unknown;
  readonly verdicts?: unknown;
  readonly messages?: unknown;
  readonly evidence?: unknown;
  readonly evidenceDetail?: unknown;
  /** Routes to answer with a status instead of a body. */
  readonly failWith?: Readonly<Record<string, number>>;
}

/** Every off-origin request the page attempted. Asserted to stay empty. */
export interface Traffic {
  readonly offOrigin: string[];
  readonly api: string[];
  readonly authorizations: string[];
}

const record = (
  digest: string,
  protocolStatus = 'OK',
  dataStatus = 'COMPLETE',
  observedAt = '2026-06-01T11:30:00.000Z',
): Record<string, unknown> => ({
  deploymentId: DEPLOYMENT,
  evidenceDigest: digest,
  sharingLevel: 'approved-full',
  verifyStatus: 'verified',
  protocolStatus,
  dataStatus,
  observedAt,
  expiresAt: '2026-06-01T12:30:00.000Z',
  receivedAt: observedAt,
});

export const statusBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 'ictt-sentinel/hosted-api/v1',
  deploymentId: DEPLOYMENT,
  status: {
    ...record(hex('a')),
    stale: false,
    currentProtocolStatus: 'OK',
    currentDataStatus: 'COMPLETE',
    ...overrides,
  },
});

export const timelineBody = (
  items: readonly Record<string, unknown>[],
): Record<string, unknown> => ({
  schemaVersion: 'ictt-sentinel/hosted-api/v1',
  items,
  next: null,
});

export const evidenceRecord = record;

/**
 * Install the interception.
 *
 * Order matters: the API pattern is registered first so a `/v1/**` request never
 * falls through to the static handler and quietly returns HTML.
 */
export const serveConsole = async (page: Page, script: ApiScript): Promise<Traffic> => {
  const traffic: Traffic = { offOrigin: [], api: [], authorizations: [] };

  await page.route('**/*', (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.origin !== 'https://console.test') {
      // Recorded and refused. Nothing in the console should ever reach here.
      traffic.offOrigin.push(request.url());
      return route.abort('blockedbyclient');
    }

    if (url.pathname.startsWith('/v1/')) {
      traffic.api.push(url.pathname);
      const auth = request.headers()['authorization'];
      if (auth !== undefined) traffic.authorizations.push(auth);

      const failure = script.failWith?.[url.pathname];
      if (failure !== undefined) {
        return route.fulfill({
          status: failure,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'refused' }),
        });
      }

      const body =
        url.pathname === '/v1/deployments'
          ? (script.deployments ?? {
              schemaVersion: 'ictt-sentinel/hosted-api/v1',
              deployments: [
                { deploymentId: DEPLOYMENT, tenantId: 'tenant-a', sharingLevel: 'approved-full' },
              ],
              next: null,
            })
          : url.pathname.endsWith('/status')
            ? (script.status ?? statusBody())
            : url.pathname.endsWith('/verdicts')
              ? (script.verdicts ?? timelineBody([record(hex('a'))]))
              : url.pathname.endsWith('/messages')
                ? (script.messages ?? { schemaVersion: 'x', messages: [] })
                : url.pathname.endsWith('/evidence')
                  ? (script.evidence ?? { schemaVersion: 'x', evidence: [], next: null })
                  : (script.evidenceDetail ?? {
                      schemaVersion: 'x',
                      metadata: record(hex('a')),
                      bundle: null,
                    });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    }

    // Static artifact, served straight from dist-web.
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
    const file = join(DIST, relative);
    if (!file.startsWith(DIST) || !existsSync(file)) return route.fulfill({ status: 404 });
    return route.fulfill({
      status: 200,
      contentType: MIME[extname(file)] ?? 'application/octet-stream',
      body: readFileSync(file),
    });
  });

  return traffic;
};

/** Open the console at a route and enter the session token. */
export const openConsole = async (page: Page, hash = '#/'): Promise<void> => {
  await page.goto(`https://console.test/${hash}`);
  await page.getByLabel('Hosted API token').fill(TOKEN);
  await page.getByRole('button', { name: 'Use token' }).click();
};
