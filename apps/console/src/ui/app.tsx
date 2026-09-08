import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { ApiClient, ApiFailure } from '../api/client.js';
import type { EvidenceRecord } from '../api/contract.js';
import { deriveIncidents } from '../model/incidents.js';
import {
  DEPLOYMENT_TABS,
  deploymentRoute,
  documentTitle,
  parseRoute,
  routeHash,
  type Route,
} from '../model/route.js';
import { empty, failed, loading, notConfigured, ready, type ScreenState } from '../model/screen.js';
import { TIMEZONE_NOTE, viewerTimeZone } from '../model/format.js';
import { CoveragePage, type CoverageData } from './pages/coverage.js';
import { DeploymentsPage, type DeploymentRow } from './pages/deployments.js';
import { EvidenceDetailPage, EvidenceListPage } from './pages/evidence.js';
import { IncidentsPage } from './pages/incidents.js';
import { MessagesPage } from './pages/messages.js';
import { OnboardingPage } from './pages/onboarding.js';
import { OverviewPage, type OverviewData } from './pages/overview.js';
import { HashLink, StateBlock } from './primitives.js';

/**
 * Application shell.
 *
 * Holds the three things that must live in exactly one place:
 *
 *   the token, in memory only. Not `localStorage`, not a cookie, not a URL
 *   parameter and not a log line. An XSS in this page is bad enough without
 *   handing it a credential that outlives the tab.
 *
 *   the route, parsed from the hash by a validating parser. An unparseable
 *   fragment is a 404 page, never a partially-filled route that reaches fetch.
 *
 *   the elapsed timer, so a slow request becomes a screen that explains itself
 *   rather than a spinner that never resolves.
 */

const useElapsed = (active: boolean): number => {
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef(0);
  useEffect(() => {
    if (!active) {
      setElapsed(0);
      return;
    }
    startedAt.current = Date.now();
    const timer = setInterval(() => {
      setElapsed(Date.now() - startedAt.current);
    }, 500);
    return () => {
      clearInterval(timer);
    };
  }, [active]);
  return elapsed;
};

const useRoute = (): Route => {
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(typeof location === 'undefined' ? '' : location.hash),
  );
  useEffect(() => {
    const onChange = (): void => {
      setRoute(parseRoute(location.hash));
    };
    window.addEventListener('hashchange', onChange);
    return () => {
      window.removeEventListener('hashchange', onChange);
    };
  }, []);
  useEffect(() => {
    document.title = documentTitle(route);
  }, [route]);
  return route;
};

const TokenForm = ({ onSubmit }: { onSubmit: (token: string) => void }): JSX.Element => {
  const [value, setValue] = useState('');
  return (
    <form
      className="token panel"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(value);
        // Clear immediately: the field keeps no copy once the token is held.
        setValue('');
      }}
    >
      <label htmlFor="api-token">Hosted API token</label>
      <input
        id="api-token"
        type="password"
        autoComplete="off"
        spellCheck={false}
        aria-describedby="token-help"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
        }}
      />
      <p id="token-help">
        Held in this tab&apos;s memory only. It is not written to local storage, not put in a URL
        and not logged, so it does not survive a reload. If that is inconvenient, put the console
        behind a reverse proxy that supplies the header instead.
      </p>
      <button type="submit">Use token</button>
    </form>
  );
};

export interface AppProps {
  readonly client: ApiClient;
  readonly hasToken: boolean;
  readonly setToken: (token: string) => void;
  readonly nowMs: number;
  readonly timeZone: string | undefined;
}

/** One screen's worth of data, resolved for the active route. */
const useScreen = <T,>(
  load: () => Promise<T>,
  deps: readonly unknown[],
  enabled: boolean,
): ScreenState<T> => {
  const [state, setState] = useState<ScreenState<T>>(() => loading(0));
  const [pending, setPending] = useState(true);
  const elapsed = useElapsed(pending);

  const run = useCallback(() => {
    if (!enabled) {
      setPending(false);
      setState(
        notConfigured(
          'No API token has been entered in this tab.',
          'Enter a token above. The hosted plane is optional: local evaluation and alerting run without it.',
        ),
      );
      return;
    }
    let cancelled = false;
    setPending(true);
    load()
      .then((data) => {
        if (!cancelled) setState(ready(data));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState(
          error instanceof ApiFailure
            ? failed(error)
            : failed(
                new ApiFailure(
                  'contract',
                  'The console could not read that response.',
                  'Reload the page. If it repeats, the console and the API are different versions.',
                ),
              ),
        );
      })
      .finally(() => {
        if (!cancelled) setPending(false);
      });
    return () => {
      cancelled = true;
    };
    // `deps` is the route input list the caller passes; the exhaustive-deps
    // plugin is not installed, so this is checked by review and by the tests
    // that exercise each route.
  }, deps);

  useEffect(() => run(), [run]);
  return pending ? loading(elapsed) : state;
};

export const App = ({ client, hasToken, setToken, nowMs, timeZone }: AppProps): JSX.Element => {
  const route = useRoute();
  const deploymentId = 'deploymentId' in route ? route.deploymentId : null;

  const list = useScreen<readonly DeploymentRow[]>(
    async () => {
      const grants = await client.deployments();
      const rows: DeploymentRow[] = [];
      for (const g of grants.items) {
        const status = await client.status(g.deploymentId);
        rows.push({ grant: g, status, chains: null });
      }
      return rows;
    },
    [hasToken],
    hasToken && route.page === 'deployments',
  );

  const overview = useScreen<OverviewData>(
    async () => {
      if (deploymentId === null) throw new ApiFailure('not-found', 'No deployment', 'Pick one.');
      const status = await client.status(deploymentId);
      if (status === null) {
        throw new ApiFailure(
          'not-found',
          'No evaluation has been uploaded for this deployment yet.',
          'Run the local agent, or raise the sharing level so it may upload.',
        );
      }
      const detail = await client
        .evidenceDetail(deploymentId, status.evidenceDigest)
        .catch(() => null);
      return {
        status,
        bundle: detail?.bundle ?? null,
        sharingLevel: status.sharingLevel,
      };
    },
    [hasToken, deploymentId],
    hasToken && (route.page === 'overview' || route.page === 'coverage'),
  );

  const messages = useScreen(
    () => (deploymentId === null ? Promise.resolve([]) : client.messages(deploymentId)),
    [hasToken, deploymentId],
    hasToken && route.page === 'messages',
  );

  const timeline = useScreen<readonly EvidenceRecord[]>(
    async () => (deploymentId === null ? [] : (await client.verdicts(deploymentId)).items),
    [hasToken, deploymentId],
    hasToken && (route.page === 'incidents' || route.page === 'evidence'),
  );

  const detail = useScreen(
    () =>
      route.page === 'evidence-detail'
        ? client.evidenceDetail(route.deploymentId, route.digest)
        : Promise.reject(new ApiFailure('not-found', 'No record', 'Pick a record.')),
    [hasToken, deploymentId, route.page === 'evidence-detail' ? route.digest : null],
    hasToken && route.page === 'evidence-detail',
  );

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="masthead">
        <div>
          <h1>ictt-sentinel</h1>
          <p className="subtitle">
            ICM / ICTT Teminat Yeterliliği ve Değişmezlik Nöbetçisi — read-only operator console
          </p>
        </div>
        <div className="meta">
          <div>{TIMEZONE_NOTE}</div>
          <div>{viewerTimeZone(timeZone)}</div>
        </div>
      </header>

      <nav className="tabs" aria-label="Sections">
        <HashLink to={routeHash({ page: 'deployments' })} current={route.page === 'deployments'}>
          Deployments
        </HashLink>
        <HashLink to={routeHash({ page: 'onboarding' })} current={route.page === 'onboarding'}>
          Onboarding
        </HashLink>
      </nav>

      {hasToken ? null : <TokenForm onSubmit={setToken} />}

      {deploymentId === null ? null : (
        <nav className="tabs" aria-label={`Views for ${deploymentId}`}>
          {DEPLOYMENT_TABS.map((tab) => (
            <HashLink
              key={tab.page}
              to={routeHash(deploymentRoute(tab.page, deploymentId))}
              current={route.page === tab.page}
            >
              {tab.label}
            </HashLink>
          ))}
        </nav>
      )}

      {route.page === 'deployments' ? (
        <DeploymentsPage
          state={
            list.kind === 'ready' && list.data.length === 0
              ? empty(
                  'This token can read no deployments.',
                  'A tenant must be granted a deployment before it appears here. Grants are made by an operator, never from this console.',
                )
              : list
          }
          nowMs={nowMs}
        />
      ) : route.page === 'onboarding' ? (
        <OnboardingPage />
      ) : route.page === 'overview' ? (
        <OverviewPage state={overview} nowMs={nowMs} />
      ) : route.page === 'coverage' ? (
        <CoveragePage
          state={
            overview.kind === 'ready'
              ? ready<CoverageData>({
                  bundle: overview.data.bundle,
                  sharingLevel: overview.data.sharingLevel,
                })
              : overview
          }
        />
      ) : route.page === 'messages' ? (
        <MessagesPage state={messages} deploymentId={deploymentId ?? ''} />
      ) : route.page === 'incidents' ? (
        <IncidentsPage
          state={timeline.kind === 'ready' ? ready(deriveIncidents(timeline.data)) : timeline}
          deploymentId={deploymentId ?? ''}
          nowMs={nowMs}
        />
      ) : route.page === 'evidence' ? (
        <EvidenceListPage state={timeline} deploymentId={deploymentId ?? ''} nowMs={nowMs} />
      ) : route.page === 'evidence-detail' ? (
        <EvidenceDetailPage state={detail} />
      ) : (
        <main id="main">
          <StateBlock
            tone="neutral"
            title="No such page"
            reason="That link does not address anything in this console."
            remedy="Go back to the deployment list."
          />
        </main>
      )}

      <footer>
        <p className="caveat">
          Read-only. This console holds no key, connects to no RPC endpoint, offers no wallet and
          cannot send a transaction, pause a contract or approve a baseline.
        </p>
      </footer>
    </div>
  );
};
