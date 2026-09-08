import { expect, test } from '@playwright/test';
import {
  DEPLOYMENT,
  TOKEN,
  evidenceRecord,
  openConsole,
  serveConsole,
  statusBody,
  timelineBody,
} from './harness.js';

const hex = (c: string, n = 64): string => c.repeat(n);

/**
 * The five journeys an operator actually takes.
 *
 * Each runs against the built bundle in a real browser. The shared assertion at
 * the end of most of them is the one that matters most: the page contacted its
 * own origin and nothing else.
 */

test('onboarding reviews a candidate draft and approves nothing', async ({ page }) => {
  const traffic = await serveConsole(page, {});
  await page.goto('https://console.test/#/onboarding');

  await expect(page.getByRole('heading', { name: 'Onboarding' })).toBeVisible();
  await expect(page.getByText('This console is read-only')).toBeVisible();

  await page.getByLabel(/discover --json/).fill(
    JSON.stringify({
      metadata: { name: DEPLOYMENT },
      spec: {
        asset: { mode: 'canonical-erc20' },
        home: {
          name: 'home',
          chain: {
            blockchainId: `0x${hex('1')}`,
            endpoints: [
              {
                id: 'a',
                trustDomain: 'alpha',
                providerGroup: 'shared',
                role: 'primary',
                archiveDepth: 'full',
                secretRef: 'ICTT_SENTINEL_HOME_A',
              },
              {
                id: 'b',
                trustDomain: 'beta',
                providerGroup: 'shared',
                role: 'secondary',
                archiveDepth: 'pruned',
                secretRef: 'ICTT_SENTINEL_HOME_B',
              },
            ],
          },
        },
        remotes: [
          {
            name: 'remote',
            chain: { blockchainId: `0x${hex('2')}`, endpoints: [] },
            tokenRemote: { address: `0x${hex('3', 40)}` },
          },
        ],
      },
    }),
  );
  await page.getByRole('button', { name: 'Summarise draft' }).click();

  // Variable names are shown; a value never is, and there is no field for one.
  await expect(
    page.getByRole('listitem').filter({ hasText: 'ICTT_SENTINEL_HOME_A' }),
  ).toBeVisible();
  await expect(page.getByRole('cell', { name: 'ICTT_SENTINEL_HOME_A' })).toBeVisible();
  // Two endpoints sharing a provider group are one witness, and the page says so.
  await expect(page.locator('.caveat', { hasText: 'one witness, not two' })).toBeVisible();
  // Nothing on the page can approve the candidate.
  await expect(page.getByRole('button', { name: /approve/i })).toHaveCount(0);
  expect(traffic.offOrigin).toEqual([]);
});

test('onboarding refuses a draft that carries a credential', async ({ page }) => {
  await serveConsole(page, {});
  await page.goto('https://console.test/#/onboarding');
  await page.getByLabel(/discover --json/).fill(
    JSON.stringify({
      spec: {
        home: {
          chain: {
            endpoints: [{ id: 'a', secretRef: 'https://rpc.example.com/v1/secret-project-key' }],
          },
        },
      },
    }),
  );
  await page.getByRole('button', { name: 'Summarise draft' }).click();

  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Refused');
  // The refusal names the path and never echoes the value.
  await expect(alert).not.toContainText('rpc.example.com');
});

test('healthy evidence reads through to a pinned block', async ({ page }) => {
  const traffic = await serveConsole(page, {
    verdicts: timelineBody([evidenceRecord(hex('a'))]),
    evidenceDetail: {
      schemaVersion: 'x',
      metadata: evidenceRecord(hex('a')),
      bundle: null,
    },
  });
  await openConsole(page, '#/');

  await expect(page.getByRole('link', { name: DEPLOYMENT })).toBeVisible();
  await expect(page.getByText('Reconciled').first()).toBeVisible();

  await page.getByRole('link', { name: DEPLOYMENT }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Reconciled at the pinned blocks' }),
  ).toBeVisible();

  // The token travelled as a header, on this origin only, and never in a URL.
  expect(traffic.authorizations.every((a) => a === `Bearer ${TOKEN}`)).toBe(true);
  expect(traffic.api.every((p) => !p.includes(TOKEN))).toBe(true);
  expect(traffic.offOrigin).toEqual([]);
});

test('a provider disagreement is never shown as healthy', async ({ page }) => {
  await serveConsole(page, {
    status: statusBody({
      protocolStatus: 'OK',
      dataStatus: 'DIVERGENT',
      currentProtocolStatus: 'OK',
      currentDataStatus: 'DIVERGENT',
    }),
  });
  await openConsole(page, `#/d/${DEPLOYMENT}`);

  await expect(page.getByRole('heading', { name: 'Independent witnesses disagree' })).toBeVisible();
  await expect(page.getByText('Witnesses disagree', { exact: true })).toBeVisible();
  // The reported value is still visible, but it is not presented as healthy.
  await expect(page.getByText('Not relied upon')).toBeVisible();
  await expect(page.locator('.badge[data-tone="ok"]')).toHaveCount(0);
});

test('a confirmed breach is worded and toned apart from a blind spot', async ({ page }) => {
  await serveConsole(page, {
    status: statusBody({
      protocolStatus: 'CRITICAL',
      currentProtocolStatus: 'CRITICAL',
    }),
  });
  await openConsole(page, `#/d/${DEPLOYMENT}`);

  await expect(
    page.getByRole('heading', { name: /Breach observed with sufficient evidence/ }),
  ).toBeVisible();
  await expect(page.locator('.badge[data-tone="critical"]').first()).toBeVisible();
  // A breach must never be dressed as an unresolved check.
  await expect(page.getByText('Not established')).toHaveCount(0);
  await expect(page.locator('.state[data-tone="critical"]')).toBeVisible();
});

test('an incident closes when a later evaluation reconciles', async ({ page }) => {
  await serveConsole(page, {
    verdicts: timelineBody([
      evidenceRecord(hex('4'), 'OK', 'COMPLETE', '2026-06-01T11:00:00.000Z'),
      evidenceRecord(hex('3'), 'CRITICAL', 'COMPLETE', '2026-06-01T10:00:00.000Z'),
      evidenceRecord(hex('2'), 'CRITICAL', 'COMPLETE', '2026-06-01T09:00:00.000Z'),
    ]),
  });
  await openConsole(page, `#/d/${DEPLOYMENT}/incidents`);

  await expect(page.getByRole('heading', { name: 'Incidents' })).toBeVisible();
  const row = page.locator('tbody tr').first();
  // Two evaluations folded into one incident, and it recovered.
  await expect(row).toContainText('2');
  await expect(row).toContainText('2026-06-01 11:00:00 UTC');
  await expect(page.getByText(/This incident recovered/)).toBeVisible();
  // Acknowledging is not offered here, and it is explained why.
  await expect(page.getByRole('button', { name: /acknowledge/i })).toHaveCount(0);
  await expect(page.getByText(/It changes no verdict and performs no chain action/)).toBeVisible();
});

test('an unreachable API says so without claiming a deployment is healthy', async ({ page }) => {
  await serveConsole(page, { failWith: { '/v1/deployments': 500 } });
  await openConsole(page, '#/');

  await expect(page.getByRole('heading', { name: /could not load this/ })).toBeVisible();
  await expect(page.getByText(/Nothing on this page should be read as healthy/)).toBeVisible();
  await expect(page.locator('.badge[data-tone="ok"]')).toHaveCount(0);
});

test('the console reaches no origin but its own and exposes no wallet', async ({ page }) => {
  const traffic = await serveConsole(page, {});
  await openConsole(page, `#/d/${DEPLOYMENT}`);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

  expect(traffic.offOrigin).toEqual([]);
  // No injected provider is touched, and none is required.
  expect(await page.evaluate(() => 'ethereum' in window)).toBe(false);
  // Nothing persisted the token: a reload starts from the sign-in form.
  expect(
    await page.evaluate(() => ({ ls: localStorage.length, ss: sessionStorage.length })),
  ).toEqual({
    ls: 0,
    ss: 0,
  });
  await page.reload();
  await expect(page.getByLabel('Hosted API token')).toBeVisible();
});

test('keyboard alone reaches the main content', async ({ page }) => {
  await serveConsole(page, {});
  // Before anything is clicked, so the first Tab starts from the document.
  await page.goto('https://console.test/#/');

  await page.keyboard.press('Tab');
  // The first stop is the skip link, which is what makes a table-heavy page usable.
  await expect(page.locator('a.skip-link:focus')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#main$/);
});

test('reflows to a narrow viewport without a horizontally scrolling page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await serveConsole(page, {});
  await openConsole(page, '#/');
  await expect(page.getByRole('heading', { name: 'Deployments' })).toBeVisible();

  // Wide tables scroll inside their own container; the document never does.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});
