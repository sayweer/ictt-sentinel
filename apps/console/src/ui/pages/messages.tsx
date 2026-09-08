import type { JSX } from 'react';
import type { MessageRow } from '../../api/contract.js';
import { shortDigest } from '../../model/format.js';
import type { ScreenState } from '../../model/screen.js';
import { Caveat, HashLink, ScreenFallback, StateBlock, Table, Timeline } from '../primitives.js';
import { routeHash } from '../../model/route.js';

/**
 * Message lifecycle.
 *
 * Delivery and execution are separate states and are rendered as separate
 * states. A Teleporter message that was DELIVERED has arrived at the messenger;
 * it has not necessarily done anything to a balance. Collapsing the two - the
 * mistake this page exists to prevent - turns a stuck bridge into a green row
 * (CLAUDE.md 5).
 *
 * Attempts and effects are also kept apart. A retried execution is another
 * attempt, never another economic effect, so a message with three execution
 * attempts and one effect is normal and is shown as such.
 */

const STATE_MEANING: Readonly<Record<string, string>> = {
  'intent-observed': 'The source application emitted an intent. Nothing has moved.',
  'source-application-emitted': 'The source application emitted its own event.',
  'source-accounted': 'The source side recorded the accounting change.',
  'icm-sent': 'The message was sent through Teleporter.',
  delivered: 'Delivered to the destination messenger. This is NOT execution.',
  'execution-succeeded': 'The destination application executed successfully.',
  'execution-failed': 'The destination application executed and failed.',
  'execution-retried': 'Execution was retried. A retry is another attempt, not another effect.',
  'receipt-observed': 'A receipt was observed on the return path.',
  unreceivable: 'The message can no longer be received.',
  orphaned: 'The block carrying this message was not accepted.',
  'paused-version': 'The registry protocol version is paused for this route.',
  unsupported: 'This build does not interpret this shape, so no claim is made.',
};

const meaning = (state: string): string =>
  STATE_MEANING[state] ??
  'This build does not recognise this state, so it makes no claim about it.';

export const MessagesPage = ({
  state,
  deploymentId,
}: {
  state: ScreenState<readonly MessageRow[]>;
  deploymentId: string;
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
        <h2>Message lifecycle</h2>
        <StateBlock
          tone="neutral"
          title="No messages in the shared evidence"
          reason="Either no ICM message was observed in the evaluated window, or the operator has not shared full evidence for this deployment."
          remedy="Check the sharing level on the overview page. An empty list is not a claim that nothing happened."
        />
      </main>
    );
  }

  return (
    <main id="main">
      <h2>Message lifecycle</h2>
      <Table
        caption="Messages observed in the shared evidence"
        summary={`${String(state.data.length)} messages. Delivery and execution are separate columns; a delivered message has not necessarily executed.`}
        headers={[
          'Message',
          'Route',
          'State',
          'Send attempts',
          'Execution attempts',
          'Economic effects',
          'Evidence',
        ]}
      >
        {state.data.map((m) => (
          <tr key={`${m.messageId}-${m.evidenceDigest}`}>
            <th scope="row" className="mono" title={m.messageId}>
              {shortDigest(m.messageId)}
            </th>
            <td className="mono">
              {shortDigest(m.sourceBlockchainId, 6)} → {shortDigest(m.destinationBlockchainId, 6)}
            </td>
            <td>
              {m.state}
              <div className="visually-hidden">{meaning(m.state)}</div>
            </td>
            <td>{String(m.sendAttempts)}</td>
            <td>{String(m.executionAttempts)}</td>
            <td>{String(m.economicEffectCount)}</td>
            <td>
              <HashLink
                to={routeHash({ page: 'evidence-detail', deploymentId, digest: m.evidenceDigest })}
              >
                <span className="mono">{shortDigest(m.evidenceDigest)}</span>
              </HashLink>
            </td>
          </tr>
        ))}
      </Table>

      {state.data.map((m) => (
        <section
          className="panel"
          key={`timeline-${m.messageId}`}
          aria-labelledby={`t-${m.messageId}`}
        >
          <h3 id={`t-${m.messageId}`} className="mono">
            {shortDigest(m.messageId)}
          </h3>
          <p>{meaning(m.state)}</p>
          <Timeline
            label={`Transition timeline for message ${m.messageId}`}
            summary={`${String(m.timeline.length)} recorded transitions, oldest first. Each links to the raw fact digest it rests on.`}
            items={m.timeline.map((t, i) => ({
              key: `${t.kind}-${String(i)}`,
              content: (
                <>
                  <strong>{t.kind}</strong>
                  <div>{meaning(t.kind)}</div>
                  <div className="mono" title={t.factDigest}>
                    fact {shortDigest(t.factDigest)}
                  </div>
                </>
              ),
            }))}
          />
          {m.envelopeIds.length === 0 ? null : (
            <p>
              Envelopes:{' '}
              <span className="mono">{m.envelopeIds.map((e) => shortDigest(e, 6)).join(', ')}</span>
            </p>
          )}
          {m.executionAttempts > 1 && m.economicEffectCount <= 1 ? (
            <Caveat>
              This route was retried. Retries are additional attempts, never additional economic
              effects, and the effect count above reflects that.
            </Caveat>
          ) : null}
        </section>
      ))}

      <Caveat>
        A causal gap - a transition observed without the transition that must precede it - leaves
        the message state unresolved rather than advancing it. Unresolved is never rendered as
        executed.
      </Caveat>
    </main>
  );
};
