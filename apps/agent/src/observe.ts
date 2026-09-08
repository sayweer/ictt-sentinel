import { evaluateHealth, type AgentState, type ReadinessPolicy } from './health.js';
import type { MetricsRegistry } from './metrics.js';

/**
 * The agent's observability surface.
 *
 * A pure request handler, so the container's probes, the tests and any HTTP
 * adapter all go through the same code path. The `node:http` server in
 * `serve.ts` is a twenty-line shim over this; nothing about the answers depends
 * on it.
 *
 * Read-only and unauthenticated by design, which is exactly why it is bound to
 * loopback by default and why the metrics registry refuses high-cardinality and
 * credential-shaped label values. Everything reachable here is safe to be seen
 * by whoever can already see the process.
 */

export interface ObserveResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

export interface ObserveContext {
  readonly state: AgentState;
  readonly registry: MetricsRegistry;
  readonly policy: ReadinessPolicy;
  readonly nowMs: number;
}

const json = (status: number, value: unknown): ObserveResponse => ({
  status,
  contentType: 'application/json; charset=utf-8',
  body: `${JSON.stringify(value)}\n`,
});

export const OBSERVE_PATHS = ['/healthz', '/readyz', '/metrics'] as const;

export const handleObserve = (path: string, context: ObserveContext): ObserveResponse => {
  const report = evaluateHealth(context.state, context.nowMs, context.policy);

  switch (path) {
    case '/healthz':
      // Liveness only. Deliberately independent of the database: failing this on
      // a database outage would restart-loop the agent and lose the in-memory
      // state that lets it recover cleanly when the database returns.
      return json(200, { live: report.live, uptimeSeconds: report.uptimeSeconds });

    case '/readyz':
      // Truth-path readiness. 503 when the answer is not established, including
      // when the newest verdict is UNKNOWN: an unresolved deployment is never
      // reported as a healthy one (docs/adr/0003-fail-closed-verdicts.md).
      return json(report.ready ? 200 : 503, {
        ready: report.ready,
        reasons: report.reasons,
        degraded: report.degraded,
        uptimeSeconds: report.uptimeSeconds,
      });

    case '/metrics':
      return {
        status: 200,
        contentType: 'text/plain; version=0.0.4; charset=utf-8',
        body: context.registry.render(),
      };

    default:
      // No route listing and no echo of the requested path: an error page that
      // reflects its input is a small XSS and a large information leak.
      return json(404, { error: 'not-found' });
  }
};
