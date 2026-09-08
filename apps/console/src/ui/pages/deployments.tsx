import type { JSX } from 'react';
import type { DeploymentGrant, DeploymentStatus } from '../../api/contract.js';
import { statusView } from '../../model/verdict.js';
import { AGGREGATE_SCORE_IS_NOT_PROVIDED } from '../../model/verdict.js';
import { formatAge, formatInstant, shortDigest, TIMEZONE_NOTE } from '../../model/format.js';
import { deriveCondition, type ScreenState } from '../../model/screen.js';
import { routeHash } from '../../model/route.js';
import { Badge, Caveat, HashLink, ScreenFallback, StateBlock, Table } from '../primitives.js';

/**
 * Deployment list.
 *
 * Two status columns, never one. A reader must be able to tell "the accounting
 * reconciles" from "we could read the chain", because a green protocol status on
 * stale data is the single most dangerous cell this product could render.
 *
 * There is deliberately no aggregate score column and no sorting by severity
 * into a single "worst first" number: the two statuses are independently
 * actionable (docs/INVARIANTS.md).
 */

export interface DeploymentRow {
  readonly grant: DeploymentGrant;
  readonly status: DeploymentStatus | null;
  /** Chains named in the shared bundle, or `null` when not shared. */
  readonly chains: readonly string[] | null;
}

export const DeploymentsPage = ({
  state,
  nowMs,
}: {
  state: ScreenState<readonly DeploymentRow[]>;
  nowMs: number;
}): JSX.Element => {
  if (state.kind !== 'ready')
    return (
      <main id="main">
        <ScreenFallback state={state} />
      </main>
    );

  if (state.data.length === 0) {
    return (
      <main id="main">
        <h2>Deployments</h2>
        <StateBlock
          tone="neutral"
          title="This token can read no deployments"
          reason="A tenant must be granted a deployment before it appears here."
          remedy="Grants are made by an operator against the database, never from this console."
        />
      </main>
    );
  }

  return (
    <main id="main">
      <h2>Deployments</h2>
      <Table
        caption="Deployments this token may read"
        summary={`${String(state.data.length)} deployments. Each row reports a protocol status and a data status separately, plus how fresh the evidence is.`}
        headers={[
          'Deployment',
          'Protocol status',
          'Data status',
          'Freshness',
          'Last evidence',
          'Chains',
        ]}
      >
        {state.data.map((row) => {
          const { status } = row;
          const view = status === null ? null : statusView(status);
          return (
            <tr key={row.grant.deploymentId}>
              <th scope="row">
                <HashLink
                  to={routeHash({ page: 'overview', deploymentId: row.grant.deploymentId })}
                >
                  {row.grant.deploymentId}
                </HashLink>
              </th>
              <td>
                {view === null ? (
                  <span>No evaluation received</span>
                ) : (
                  <>
                    <Badge badge={view.protocol} />
                    <div className="visually-hidden">
                      {view.protocol.meaning}
                      {deriveCondition({ status: status as DeploymentStatus }) === 'critical'
                        ? ' This is a proven breach, not a blind spot.'
                        : ''}
                    </div>
                  </>
                )}
              </td>
              <td>{view === null ? '—' : <Badge badge={view.data} />}</td>
              <td>
                {status === null
                  ? '—'
                  : status.stale
                    ? `Stale · observed ${formatAge(status.observedAt, nowMs)}`
                    : `Fresh · observed ${formatAge(status.observedAt, nowMs)}`}
              </td>
              <td>
                {status === null ? (
                  '—'
                ) : (
                  <HashLink
                    to={routeHash({
                      page: 'evidence-detail',
                      deploymentId: row.grant.deploymentId,
                      digest: status.evidenceDigest,
                    })}
                  >
                    <span className="mono" title={status.evidenceDigest}>
                      {shortDigest(status.evidenceDigest)}
                    </span>
                  </HashLink>
                )}
                <div className="visually-hidden">
                  {status === null ? '' : formatInstant(status.observedAt)}
                </div>
              </td>
              <td>
                {row.chains === null
                  ? `Not shared at ${row.grant.sharingLevel}`
                  : row.chains.length === 0
                    ? 'None reported'
                    : String(row.chains.length)}
              </td>
            </tr>
          );
        })}
      </Table>
      <Caveat>
        {AGGREGATE_SCORE_IS_NOT_PROVIDED} {TIMEZONE_NOTE}
      </Caveat>
    </main>
  );
};
