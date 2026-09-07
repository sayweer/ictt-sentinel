import type { EvidenceBundle } from './schema.js';
import { redact } from './redact.js';

/**
 * Human-readable projection.
 *
 * A rendering of the canonical core, never a second source of truth: it derives
 * everything from `core` and changes no byte of it, so the content hash is
 * unaffected by anything in this file.
 *
 * The wording is as load-bearing as the numbers. "Reported upper bound covered"
 * and "solvent" describe different worlds, and only the first is something this
 * product can say (CLAUDE.md 9).
 */

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Human wording per status. Nothing here promises more than was established. */
const STATUS_WORDING: Readonly<Record<string, string>> = {
  OK: 'Observed onchain coverage reconciled at the pinned blocks',
  WARN: 'Policy or liveness deviation observed; not evidence of an economic breach',
  CRITICAL: 'Deterministic breach observed with sufficient evidence',
  UNKNOWN: 'Could not be established from the available evidence',
};

const CLAIM_WORDING: Readonly<Record<string, string>> = {
  EXACT: 'Exact reconciliation',
  CAUSAL_EXACT: 'Exact once causally settled envelopes are accounted for',
  SUFFICIENT_UPPER_BOUND: 'Reported supply upper bound is covered (not an exact supply claim)',
  INDETERMINATE: 'The evidence does not decide this either way',
  UNSUPPORTED: 'This deployment shape is not interpreted by this build',
};

const row = (k: string, v: string): string =>
  `<tr><th scope="row">${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`;

const list = (items: readonly string[]): string =>
  items.length === 0
    ? '<p class="none">None.</p>'
    : `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`;

/**
 * Render the bundle.
 *
 * Output is passed through the same redaction as every log line: a projection
 * that leaked what the core does not carry would defeat the point.
 */
export const renderHtml = (bundle: EvidenceBundle): string => {
  const { core } = bundle;
  const v = core.verdict;

  const body = `<!-- generated from evidence core ${escapeHtml(bundle.contentHash)} -->
<title>ICTT Sentinel evidence ${escapeHtml(core.deploymentId)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.55 system-ui, sans-serif; margin: 0 auto; max-width: 60rem; padding: 2rem 1rem; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  .sub { color: #666; margin: 0 0 2rem; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 2rem; }
  th, td { border-bottom: 1px solid #8884; padding: .5rem .75rem; text-align: left; vertical-align: top; }
  th[scope=row] { width: 16rem; font-weight: 600; }
  code { font-family: ui-monospace, monospace; word-break: break-all; }
  .none { color: #666; font-style: italic; }
  .caveat { border-left: 3px solid #8886; padding: .5rem 0 .5rem 1rem; margin: 2rem 0; }
</style>
<h1>Evidence &mdash; ${escapeHtml(core.deploymentId)}</h1>
<p class="sub">Reproducible and audit-shareable. <strong>Not tamper-proof.</strong></p>

<h2>Verdict</h2>
<table>
  ${row('Protocol status', `${v.protocolStatus} — ${STATUS_WORDING[v.protocolStatus] ?? ''}`)}
  ${row('Data status', v.dataStatus)}
  ${row('Claim mode', `${v.claimMode} — ${CLAIM_WORDING[v.claimMode] ?? ''}`)}
  ${row('Coverage', v.coverage)}
  ${row('Reason codes', v.reasonCodes.join(', ') || 'none')}
</table>

<h2>Provenance</h2>
<table>
  ${row('Content hash', bundle.contentHash)}
  ${row('Schema', core.producer.schemaVersion)}
  ${row('Build commit', core.producer.buildCommit)}
  ${row('Artifact checksum', core.producer.artifactChecksum)}
  ${row('Source lock', `${core.sourceLock.commitSha} (${core.sourceLock.adapterId} v${String(core.sourceLock.adapterVersion)})`)}
  ${row('Manifest hash', core.baseline.manifestHash)}
  ${row('Policy hash', core.baseline.policyHash)}
  ${row('Previous bundle', core.previousBundleHash ?? 'none')}
</table>

<h2>Pinned blocks</h2>
<table>
  ${core.chains
    .map((c) => row(c.blockchainId, `#${c.blockNumber} ${c.blockHash} (${c.finalityBasis})`))
    .join('')}
</table>

<h2>Witness quorum</h2>
<table>
  ${row('Independent groups', `${String(core.quorum.independentGroups)} of ${String(core.quorum.requiredGroups)} required`)}
  ${core.quorum.votes
    .map((w) => row(w.endpointId, `${w.providerGroup} — ${w.agreed ? 'agreed' : 'disagreed'}`))
    .join('')}
</table>
<p class="caveat">${escapeHtml(core.quorum.note)}</p>

<h2>Census</h2>
<table>
  ${row('Completeness', core.census.completeness)}
  ${row('Registered remotes', String(core.census.registeredRemotes.length))}
  ${row('Missing remotes', core.census.missingRemotes.join(', ') || 'none')}
</table>

<h2>Freshness</h2>
<table>
  ${row('Observed at', core.completeness.observedAt)}
  ${row('Expires at', core.completeness.expiresAt)}
  ${row('Fresh', core.completeness.fresh ? 'yes' : 'no')}
</table>

<h2>Missing or contradictory evidence</h2>
${list([...core.completeness.missingEvidence, ...core.completeness.contradictoryEvidence])}

<h2>Assumptions</h2>
${list(core.assurance.assumptions)}

<h2>Exclusions</h2>
${list(core.assurance.exclusions)}

<h2>Non-goals</h2>
${list(core.assurance.nonGoals)}

<p class="caveat">
  Assurance mode: ${escapeHtml(core.assurance.assuranceMode)}.
  Quorum counts independent provider groups; it is not a cryptographic or Byzantine guarantee.
  Observed onchain state is coverage at the pinned blocks, not legal recoverability.
</p>`;

  return redact(body);
};
