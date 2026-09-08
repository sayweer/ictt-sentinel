import type { JSX } from 'react';
import type { EvidenceDetailResponse, EvidenceRecord } from '../../api/contract.js';
import { OFFLINE_VERIFICATION_NOTE, downloadPayload, provenancePanel } from '../../model/bundle.js';
import { formatAge, formatInstant, shortDigest, TIMEZONE_NOTE } from '../../model/format.js';
import { dataBadge, protocolBadge } from '../../model/verdict.js';
import type { ScreenState } from '../../model/screen.js';
import { routeHash } from '../../model/route.js';
import {
  Badge,
  Caveat,
  HashLink,
  Pairs,
  ScreenFallback,
  StateBlock,
  Table,
} from '../primitives.js';

/**
 * Evidence.
 *
 * The console displays the verification status the API recorded and never
 * claims to have verified anything itself. Independent verification is an
 * offline act with the CLI, on a machine the reader trusts - a browser telling
 * you that a browser checked the hash proves very little.
 *
 * Export writes exactly what this page rendered, re-serialised from the parsed
 * bundle, so what an auditor receives is what an operator saw.
 */

export const EvidenceListPage = ({
  state,
  deploymentId,
  nowMs,
}: {
  state: ScreenState<readonly EvidenceRecord[]>;
  deploymentId: string;
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
        <h2>Evidence</h2>
        <StateBlock
          tone="neutral"
          title="No evidence uploaded"
          reason="No evaluation has reached the hosted plane for this deployment."
          remedy="The default sharing level is local-only, so this is the expected state until an operator raises it. Local evaluation and evidence still run."
        />
      </main>
    );
  }

  return (
    <main id="main">
      <h2>Evidence</h2>
      <Table
        caption="Evidence records uploaded for this deployment"
        summary={`${String(state.data.length)} records, newest first. Verification status is what the API recorded; verify independently with the CLI.`}
        headers={['Digest', 'Observed', 'Protocol', 'Data', 'Sharing', 'Verification']}
      >
        {state.data.map((record) => (
          <tr key={record.evidenceDigest}>
            <th scope="row">
              <HashLink
                to={routeHash({
                  page: 'evidence-detail',
                  deploymentId,
                  digest: record.evidenceDigest,
                })}
              >
                <span className="mono" title={record.evidenceDigest}>
                  {shortDigest(record.evidenceDigest)}
                </span>
              </HashLink>
            </th>
            <td>
              {formatInstant(record.observedAt)}
              <div className="visually-hidden">{formatAge(record.observedAt, nowMs)}</div>
            </td>
            <td>
              <Badge badge={protocolBadge(record.protocolStatus)} />
            </td>
            <td>
              <Badge badge={dataBadge(record.dataStatus)} />
            </td>
            <td>{record.sharingLevel}</td>
            <td>{record.verifyStatus}</td>
          </tr>
        ))}
      </Table>
      <Caveat>{TIMEZONE_NOTE}</Caveat>
    </main>
  );
};

/**
 * Trigger a download of the bundle.
 *
 * A blob URL created and revoked in the same turn: nothing is uploaded, no third
 * party is contacted, and the object URL does not outlive the click.
 */
const download = (name: string, contents: string): void => {
  const blob = new Blob([contents], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
};

export const EvidenceDetailPage = ({
  state,
}: {
  state: ScreenState<EvidenceDetailResponse>;
}): JSX.Element => {
  if (state.kind !== 'ready')
    return (
      <main id="main">
        <ScreenFallback state={state} />
      </main>
    );
  const { metadata, bundle } = state.data;

  return (
    <main id="main">
      <h2>Evidence record</h2>
      <section className="panel" aria-labelledby="metadata-heading">
        <h3 id="metadata-heading">Record</h3>
        <Pairs
          items={[
            [
              'Content digest',
              <span key="d" className="mono">
                {metadata.evidenceDigest}
              </span>,
            ],
            ['Observed at', formatInstant(metadata.observedAt)],
            ['Expires at', formatInstant(metadata.expiresAt)],
            ['Received at', formatInstant(metadata.receivedAt)],
            ['Protocol status', <Badge key="p" badge={protocolBadge(metadata.protocolStatus)} />],
            ['Data status', <Badge key="s" badge={dataBadge(metadata.dataStatus)} />],
            ['Sharing level', metadata.sharingLevel],
            ['Verification status', metadata.verifyStatus],
          ]}
        />
      </section>

      {bundle === null ? (
        <section className="panel">
          <h3>Bundle not shared</h3>
          <p>
            This record was uploaded as <code>{metadata.sharingLevel}</code>, so the bundle itself
            stayed on the operator&apos;s machine. The digest above still identifies it: an operator
            with local access can produce the same bytes and compare.
          </p>
        </section>
      ) : (
        <>
          <section className="panel" aria-labelledby="provenance-heading">
            <h3 id="provenance-heading">Provenance</h3>
            {(() => {
              const p = provenancePanel(bundle);
              return (
                <Pairs
                  items={[
                    ['Schema version', p.schemaVersion],
                    ['Build commit', p.buildCommit],
                    ['Artifact checksum', p.artifactChecksum],
                    ['Source lock commit', p.sourceCommit],
                    ['Adapter', p.adapter],
                    ['Manifest hash', p.manifestHash],
                    ['Policy hash', p.policyHash],
                    ['Previous bundle', p.previousBundleHash ?? 'none'],
                  ]}
                />
              );
            })()}
          </section>

          <section className="panel" aria-labelledby="pinned-heading">
            <h3 id="pinned-heading">Pinned blocks</h3>
            <Table
              caption="Every comparative read is pinned to a block number and hash"
              summary={`${String(bundle.core.chains.length)} pinned chains. Comparing two chains at latest is impossible by construction.`}
              headers={['Chain', 'Block number', 'Block hash', 'Acceptance evidence']}
            >
              {bundle.core.chains.map((c) => (
                <tr key={c.blockchainId}>
                  <th scope="row" className="mono">
                    {shortDigest(c.blockchainId)}
                  </th>
                  <td className="mono">{c.blockNumber}</td>
                  <td className="mono" title={c.blockHash}>
                    {shortDigest(c.blockHash)}
                  </td>
                  <td>{c.acceptanceEvidence}</td>
                </tr>
              ))}
            </Table>
          </section>

          <section className="panel" aria-labelledby="export-heading">
            <h3 id="export-heading">Offline verification and export</h3>
            <p>{OFFLINE_VERIFICATION_NOTE}</p>
            <p>
              <code>
                ictt-sentinel evidence verify --file {metadata.evidenceDigest}.evidence.json
              </code>
            </p>
            <button
              type="button"
              onClick={() => {
                download(`${metadata.evidenceDigest}.evidence.json`, downloadPayload(bundle));
              }}
            >
              Download bundle
            </button>
          </section>
        </>
      )}

      <Caveat>
        An evidence bundle is reproducible and audit-shareable. It is not immutable: anyone who can
        rewrite the file can recompute its hash. Detection comes from comparing the digest against a
        record the editor does not control.
      </Caveat>
    </main>
  );
};
