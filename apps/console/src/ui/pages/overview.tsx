import type { JSX } from 'react';
import type { EvidenceBundle } from '@ictt-sentinel/evidence';
import type { DeploymentStatus } from '../../api/contract.js';
import { statusView } from '../../model/verdict.js';
import { deriveCondition, isHealthyCondition, type ScreenState } from '../../model/screen.js';
import {
  censusPanel,
  chainPanels,
  fingerprintPanels,
  quorumPanel,
  verdictPanel,
} from '../../model/bundle.js';
import { formatAge, formatBlockNumber, formatInstant, shortDigest } from '../../model/format.js';
import { Badge, Caveat, ConditionBlock, Pairs, ScreenFallback, Table } from '../primitives.js';

/**
 * Deployment overview.
 *
 * Topology, census, fingerprints and witness health on one page, because those
 * four are what an operator checks before believing any number on the coverage
 * page. A registered remote that is not approved, a fingerprint that is not
 * recognised and a witness that disagreed each invalidate a coverage claim in a
 * different way, so each gets its own panel rather than a merged health line.
 */

export interface OverviewData {
  readonly status: DeploymentStatus;
  /** Present only when the operator shared full evidence. */
  readonly bundle: EvidenceBundle | null;
  readonly sharingLevel: string;
}

const NotShared = ({ what, level }: { what: string; level: string }): JSX.Element => (
  <p>
    {what} is not published at the <code>{level}</code> sharing level. This is an operator choice,
    not a gap in the evaluation: the local agent still evaluated it.
  </p>
);

export const OverviewPage = ({
  state,
  nowMs,
}: {
  state: ScreenState<OverviewData>;
  nowMs: number;
}): JSX.Element => {
  if (state.kind !== 'ready')
    return (
      <main id="main">
        <ScreenFallback state={state} />
      </main>
    );
  const { status, bundle, sharingLevel } = state.data;
  const verdict = bundle === null ? null : verdictPanel(bundle);
  const condition = deriveCondition({
    status,
    claimMode: verdict?.claimMode,
    coverage: verdict?.coverage,
    censusComplete: bundle === null ? undefined : censusPanel(bundle).complete,
  });
  // This page sees the bundle, so it knows about an incomplete census or a shape
  // this build cannot read - neither of which the status fields carry. A green
  // protocol badge beside a panel saying the census is incomplete is exactly the
  // contradiction this product exists to avoid.
  const view = statusView(status, isHealthyCondition(condition) || condition === 'warn');

  return (
    <main id="main">
      <h2>Overview</h2>
      <ConditionBlock condition={condition} />

      <section className="panel" aria-labelledby="status-heading">
        <h3 id="status-heading">Verdict fields</h3>
        <Pairs
          items={[
            ['Protocol status', <Badge key="p" badge={view.protocol} />],
            ['Protocol meaning', view.protocol.meaning],
            ...(view.qualifier === null
              ? []
              : ([['Reported value', `${view.rawProtocol.label} — ${view.qualifier}`]] as const)),
            ['Data status', <Badge key="d" badge={view.data} />],
            ['Data meaning', view.data.meaning],
            [
              'Observed at',
              `${formatInstant(status.observedAt)} (${formatAge(status.observedAt, nowMs)})`,
            ],
            ['Expires at', formatInstant(status.expiresAt)],
            [
              'Evidence digest',
              <span key="e" className="mono">
                {status.evidenceDigest}
              </span>,
            ],
            ['Verification', status.verifyStatus],
            ['Sharing level', sharingLevel],
          ]}
        />
        {view.staleNotice === null ? null : <Caveat>{view.staleNotice}</Caveat>}
      </section>

      <section className="panel" aria-labelledby="topology-heading">
        <h3 id="topology-heading">Home and remote topology</h3>
        {bundle === null ? (
          <NotShared what="Chain topology" level={sharingLevel} />
        ) : (
          <Table
            caption="Pinned blocks per chain"
            summary={`${String(chainPanels(bundle).length)} chains, each pinned to an explicit block number and hash. Comparative reads are never taken at latest.`}
            headers={['ICM blockchain id', 'EVM chain id', 'Block', 'Block hash', 'Finality basis']}
          >
            {chainPanels(bundle).map((c) => (
              <tr key={c.blockchainId}>
                <th scope="row" className="mono">
                  {shortDigest(c.blockchainId)}
                </th>
                <td>{c.evmChainId}</td>
                <td>{formatBlockNumber(c.blockNumber)}</td>
                <td className="mono" title={c.blockHash}>
                  {shortDigest(c.blockHash)}
                </td>
                <td>{c.finalityBasis}</td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      <section className="panel" aria-labelledby="census-heading">
        <h3 id="census-heading">Remote census</h3>
        {bundle === null ? (
          <NotShared what="The remote census" level={sharingLevel} />
        ) : (
          (() => {
            const census = censusPanel(bundle);
            return (
              <>
                <Pairs
                  items={[
                    ['Completeness', census.completeness],
                    ['Registered remotes', String(census.registered.length)],
                    ['Observed', String(census.registered.length - census.missing.length)],
                    ['Missing', census.missing.length === 0 ? 'none' : census.missing.join(', ')],
                    [
                      'No RPC configured',
                      census.withoutRpc.length === 0 ? 'none' : census.withoutRpc.join(', '),
                    ],
                  ]}
                />
                <Caveat>
                  A remote discovered through permissionless registration is a candidate, never
                  automatically trusted. A missing remote is listed, never counted as zero
                  liability.
                </Caveat>
              </>
            );
          })()
        )}
      </section>

      <section className="panel" aria-labelledby="fingerprint-heading">
        <h3 id="fingerprint-heading">Contract fingerprints and drift</h3>
        {bundle === null ? (
          <NotShared what="Contract fingerprints" level={sharingLevel} />
        ) : (
          <Table
            caption="Deployed code, as observed at the pinned blocks"
            summary={`${String(fingerprintPanels(bundle).length)} contracts. A fingerprint that is not recognised makes the verdict unknown, never passing.`}
            headers={['Role', 'Address', 'Runtime code hash', 'Proxy', 'Recognised']}
          >
            {fingerprintPanels(bundle).map((f) => (
              <tr key={`${f.role}-${f.address}`}>
                <th scope="row">{f.role}</th>
                <td className="mono">{f.address}</td>
                <td className="mono" title={f.runtimeCodeHash}>
                  {shortDigest(f.runtimeCodeHash)}
                </td>
                <td>{f.proxy}</td>
                <td>{f.recognised ? 'recognised' : 'not recognised'}</td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      <section className="panel" aria-labelledby="witness-heading">
        <h3 id="witness-heading">Witness and finality health</h3>
        {bundle === null ? (
          <NotShared what="Witness detail" level={sharingLevel} />
        ) : (
          (() => {
            const q = quorumPanel(bundle);
            return (
              <>
                <Pairs
                  items={[
                    [
                      'Independent provider groups',
                      `${String(q.independentGroups)} of ${String(q.requiredGroups)} required`,
                    ],
                    ['Quorum satisfied', q.satisfied ? 'yes' : 'no'],
                    ['Witnesses disagreeing', q.divergent ? 'yes' : 'no'],
                  ]}
                />
                <Table
                  caption="Witness votes on the pinned block hashes"
                  summary={`${String(q.witnesses.length)} witnesses. Endpoints appear as pseudonymous ids; no URL or token is published.`}
                  headers={['Endpoint', 'Provider group', 'Trust domain', 'Agreed']}
                >
                  {q.witnesses.map((w) => (
                    <tr key={w.endpointId}>
                      <th scope="row" className="mono">
                        {w.endpointId}
                      </th>
                      <td>{w.providerGroup}</td>
                      <td>{w.trustDomain}</td>
                      <td>{w.agreed ? 'agreed' : 'disagreed'}</td>
                    </tr>
                  ))}
                </Table>
                <Caveat>{q.note}</Caveat>
              </>
            );
          })()
        )}
      </section>
    </main>
  );
};
