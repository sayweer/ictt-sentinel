import type { JSX } from 'react';
import {
  ACKNOWLEDGEMENT_IS_NOT_IN_THIS_VIEW,
  RUNBOOK_HINT,
  type Incident,
} from '../../model/incidents.js';
import { protocolBadge } from '../../model/verdict.js';
import { formatAge, formatInstant, shortDigest } from '../../model/format.js';
import type { ScreenState } from '../../model/screen.js';
import { routeHash } from '../../model/route.js';
import {
  Badge,
  Caveat,
  HashLink,
  ScreenFallback,
  StateBlock,
  Table,
  Timeline,
} from '../primitives.js';

/**
 * Incidents.
 *
 * Derived from the verdict timeline: a run of consecutive non-OK evaluations is
 * one incident, its oldest record is the first sighting, the repeats are the
 * deduplication, and a following OK is the recovery.
 *
 * There is no acknowledge button and no chain action of any kind on this page.
 * Acknowledging needs the incident key the alerting layer derived from the rule
 * and reason, which the verdict timeline does not carry - and a button that
 * silences the wrong incident is worse than no button.
 */

export const IncidentsPage = ({
  state,
  deploymentId,
  nowMs,
}: {
  state: ScreenState<readonly Incident[]>;
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
        <h2>Incidents</h2>
        <StateBlock
          tone="neutral"
          title="No incidents in the visible timeline"
          reason="Every evaluation in the uploaded verdict timeline reconciled. That is a statement about the records present, not about the whole history of the deployment."
          remedy="The timeline is bounded by what the agent uploaded and by the page size. Widen it from the evidence page if you need more."
        />
        <Caveat>{ACKNOWLEDGEMENT_IS_NOT_IN_THIS_VIEW}</Caveat>
      </main>
    );
  }

  return (
    <main id="main">
      <h2>Incidents</h2>
      <Table
        caption="Incidents derived from the verdict timeline"
        summary={`${String(state.data.length)} incidents. Each row shows when it was first seen, how many evaluations folded into it, the worst severity reached, and whether it recovered.`}
        headers={[
          'First seen',
          'Last seen',
          'Occurrences',
          'Peak severity',
          'Current',
          'Recovered',
        ]}
      >
        {state.data.map((incident) => (
          <tr key={incident.id}>
            <th scope="row">
              {formatInstant(incident.firstSeen)}
              <div className="visually-hidden">{formatAge(incident.firstSeen, nowMs)}</div>
            </th>
            <td>{formatInstant(incident.lastSeen)}</td>
            <td>
              {String(incident.occurrences)}
              <div className="visually-hidden">evaluations deduplicated into this one incident</div>
            </td>
            <td>
              <Badge badge={protocolBadge(incident.peak)} />
            </td>
            <td>
              <Badge badge={protocolBadge(incident.current)} />
            </td>
            <td>
              {incident.recovered && incident.recoveredAt !== null
                ? formatInstant(incident.recoveredAt)
                : 'still open'}
            </td>
          </tr>
        ))}
      </Table>

      {state.data.map((incident) => (
        <section
          className="panel"
          key={`detail-${incident.id}`}
          aria-labelledby={`i-${incident.id}`}
        >
          <h3 id={`i-${incident.id}`}>Incident first seen {formatInstant(incident.firstSeen)}</h3>
          <p>
            {incident.recovered
              ? 'This incident recovered: a later evaluation reconciled at its pinned blocks.'
              : 'This incident is still open. The latest evaluation has not reconciled.'}
          </p>
          <Timeline
            label={`Evidence for the incident first seen at ${incident.firstSeen}`}
            summary={`${String(incident.evidenceDigests.length)} evidence bundles, newest first. Open the oldest one to see what the incident started from.`}
            items={incident.evidenceDigests.map((digest) => ({
              key: digest,
              content: (
                <HashLink to={routeHash({ page: 'evidence-detail', deploymentId, digest })}>
                  <span className="mono">{shortDigest(digest)}</span>
                </HashLink>
              ),
            }))}
          />
        </section>
      ))}

      <Caveat>{ACKNOWLEDGEMENT_IS_NOT_IN_THIS_VIEW}</Caveat>
      <Caveat>{RUNBOOK_HINT}</Caveat>
    </main>
  );
};
