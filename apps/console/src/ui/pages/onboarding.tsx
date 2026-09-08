import { useState, type JSX } from 'react';
import {
  BASELINE_CHECKLIST,
  NO_APPROVAL_IN_BROWSER,
  PastedSecretError,
  reviewDiscovery,
  type DiscoveryReview,
} from '../../model/onboarding.js';
import { Caveat, Pairs, Table } from '../primitives.js';

/**
 * Onboarding.
 *
 * A guided review, not a wizard that configures anything. The console cannot
 * approve a baseline, and this page says so in words rather than by omitting a
 * button: approval is a human act performed against a diff, and moving it into a
 * browser would move it to whoever can reach the browser
 * (docs/ARCHITECTURE.md 9).
 *
 * The paste box accepts the JSON `ictt-sentinel discover --json` prints. That
 * document carries environment variable NAMES by construction; if a value is in
 * there the operator pasted the wrong thing, and the input is refused rather
 * than rendered.
 */

const ReviewPanels = ({ review }: { review: DiscoveryReview }): JSX.Element => (
  <>
    <section className="panel" aria-labelledby="draft-heading">
      <h3 id="draft-heading">Candidate draft</h3>
      <Pairs
        items={[
          ['Deployment name', review.deploymentName],
          ['Asset mode', review.assetMode],
          ['Candidate remotes', String(review.candidateRemotes.length)],
        ]}
      />
      <Caveat>
        Discovery proposes; it approves nothing. A permissionlessly registered remote is a candidate
        until a human adds it to the manifest, and this page cannot do that for you.
      </Caveat>
    </section>

    <section className="panel" aria-labelledby="secrets-heading">
      <h3 id="secrets-heading">Environment variables this draft expects</h3>
      <p>
        Names only. The console has never seen these values, cannot read them, and has nowhere to
        put them. Presence is checked by <code>ictt-sentinel doctor</code>, which reports whether a
        variable is set and never what it contains.
      </p>
      <ul>
        {review.requiredSecretRefs.map((name) => (
          <li key={name} className="mono">
            {name}
          </li>
        ))}
      </ul>
    </section>

    {review.chains.map((chain) => (
      <section className="panel" key={chain.name} aria-labelledby={`chain-${chain.name}`}>
        <h3 id={`chain-${chain.name}`}>{chain.name}</h3>
        <Pairs
          items={[
            [
              'ICM blockchain id',
              <span key="b" className="mono">
                {chain.blockchainId}
              </span>,
            ],
            ['Endpoints declared', String(chain.endpoints.length)],
            ['Distinct provider groups', String(chain.distinctProviderGroups)],
            ['Distinct trust domains', String(chain.distinctTrustDomains)],
          ]}
        />
        {chain.sharedProviderGroups.length > 0 || chain.sharedTrustDomains.length > 0 ? (
          <Caveat>
            Endpoints here share a provider group or a trust domain (
            {[...chain.sharedProviderGroups, ...chain.sharedTrustDomains].join(', ')}). Endpoints
            that share an upstream are one witness, not two, and quorum counts witnesses.
          </Caveat>
        ) : null}
        <Table
          caption={`Declared endpoints for ${chain.name}`}
          summary={`${String(chain.endpoints.length)} endpoints. Each row shows the environment variable name, never a URL or a token.`}
          headers={[
            'Endpoint',
            'Provider group',
            'Trust domain',
            'Role',
            'Archive depth',
            'Env var',
          ]}
        >
          {chain.endpoints.map((e) => (
            <tr key={e.endpointId}>
              <th scope="row">{e.endpointId}</th>
              <td>{e.providerGroup}</td>
              <td>{e.trustDomain}</td>
              <td>{e.role}</td>
              <td>{e.archiveDepth}</td>
              <td className="mono">{e.secretRef}</td>
            </tr>
          ))}
        </Table>
        <Caveat>
          These are the values the draft declares. Whether they are genuinely independent is decided
          by <code>ictt-sentinel doctor</code> against your policy, not by this page.
        </Caveat>
      </section>
    ))}
  </>
);

export const OnboardingPage = (): JSX.Element => {
  const [pasted, setPasted] = useState('');
  const [review, setReview] = useState<DiscoveryReview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const inspect = (): void => {
    setReview(null);
    if (pasted.trim() === '') {
      setProblem('Paste the JSON that `ictt-sentinel discover --json` printed.');
      return;
    }
    try {
      setReview(reviewDiscovery(pasted));
      setProblem(null);
    } catch (e) {
      // The message is built from field PATHS, never from field values: a
      // refusal must not echo the secret it just refused.
      setProblem(
        e instanceof PastedSecretError
          ? `Refused: that document contains ${String(e.issues.length)} inline secret field(s) at ${e.issues.map((i) => i.path).join(', ')}. Paste the discovery draft, which carries variable names only.`
          : e instanceof Error
            ? e.message
            : 'That input could not be read.',
      );
    }
  };

  return (
    <main id="main">
      <h2>Onboarding</h2>
      <section className="state" data-tone="neutral">
        <h3>This console approves nothing</h3>
        <p>{NO_APPROVAL_IN_BROWSER}</p>
      </section>

      <section className="panel" aria-labelledby="checklist-heading">
        <h3 id="checklist-heading">Baseline review checklist</h3>
        <ol>
          {BASELINE_CHECKLIST.map((item) => (
            <li key={item.id} style={{ marginBottom: '0.75rem' }}>
              <strong>{item.title}</strong>
              <div>{item.detail}</div>
              {item.command === null ? null : (
                <div>
                  <code>{item.command}</code>
                </div>
              )}
            </li>
          ))}
        </ol>
      </section>

      <section className="panel" aria-labelledby="diff-heading">
        <h3 id="diff-heading">Review a discovery draft</h3>
        <label htmlFor="discovery-input">
          Output of <code>ictt-sentinel discover --json</code>
        </label>
        <textarea
          id="discovery-input"
          rows={8}
          value={pasted}
          spellCheck={false}
          aria-describedby="discovery-help"
          onChange={(event) => {
            setPasted(event.target.value);
          }}
        />
        <p id="discovery-help">
          Stays in this tab. It is not uploaded, not stored and not logged. A document containing a
          secret value is refused rather than displayed.
        </p>
        <button type="button" onClick={inspect}>
          Summarise draft
        </button>
        {problem === null ? null : (
          <p role="alert" className="remedy">
            {problem}
          </p>
        )}
      </section>

      {review === null ? null : <ReviewPanels review={review} />}
    </main>
  );
};
