import type { JSX } from 'react';
import type { EvidenceBundle } from '@ictt-sentinel/evidence';
import {
  COVERAGE_CAVEAT,
  NATIVE_PANEL_CAVEAT,
  claimCopy,
  coverageCopy,
} from '../../model/claim.js';
import { assetModeOf, rulePanels, verdictPanel } from '../../model/bundle.js';
import { formatBaseUnits } from '../../model/format.js';
import type { ScreenState } from '../../model/screen.js';
import { Caveat, Pairs, ScreenFallback, Table } from '../primitives.js';

/**
 * Coverage.
 *
 * The page is split by asset mode and the two halves never appear together,
 * because their vocabularies are not interchangeable:
 *
 *   canonical ERC20  a deterministic reconciliation that either holds at the
 *                    pinned blocks or does not.
 *   native           an upper-bound assessment over an accounting
 *                    reconstruction. `sufficient` / `indeterminate` / `unknown`
 *                    and nothing stronger (docs/INVARIANTS.md 7).
 *
 * Every quantity is rendered from its decimal string. Nothing on this page is
 * parsed into a JS number, because a token balance that lost its low bits is a
 * wrong answer presented confidently.
 */

export interface CoverageData {
  readonly bundle: EvidenceBundle | null;
  readonly sharingLevel: string;
}

const RuleTable = ({ bundle }: { bundle: EvidenceBundle }): JSX.Element => {
  const rules = rulePanels(bundle);
  return (
    <>
      {rules.map((rule) => (
        <section className="panel" key={rule.ruleId} aria-labelledby={`rule-${rule.ruleId}`}>
          <h3 id={`rule-${rule.ruleId}`}>
            {rule.ruleId} <span className="mono">v{rule.ruleVersion}</span>
          </h3>
          <Pairs
            items={[
              ['Result', rule.result],
              ['Unit', rule.unit],
              [
                'Reason codes',
                rule.reasonCodes.length === 0 ? 'none' : rule.reasonCodes.join(', '),
              ],
            ]}
          />
          <Table
            caption={`Inputs and intermediates for ${rule.ruleId}`}
            summary={`${String(rule.inputs.length)} inputs and ${String(rule.intermediates.length)} intermediate values, all exact base-unit integers.`}
            headers={['Name', 'Kind', 'Base units']}
          >
            {[
              ...rule.inputs.map(([k, v]) => [k, 'input', v] as const),
              ...rule.intermediates.map(([k, v]) => [k, 'intermediate', v] as const),
            ].map(([name, kind, value]) => (
              <tr key={`${kind}-${name}`}>
                <th scope="row">{name}</th>
                <td>{kind}</td>
                <td className="mono">{safeUnits(value)}</td>
              </tr>
            ))}
          </Table>
        </section>
      ))}
    </>
  );
};

/**
 * Format a recorded quantity, or show it verbatim.
 *
 * A rule input that is not a canonical integer is shown as-is rather than
 * coerced: it may be a hash, a flag or a label, and guessing would be how a
 * non-numeric field becomes a fabricated number.
 */
const safeUnits = (value: string): string => {
  try {
    return formatBaseUnits(value);
  } catch {
    return value;
  }
};

export const CoveragePage = ({ state }: { state: ScreenState<CoverageData> }): JSX.Element => {
  if (state.kind !== 'ready')
    return (
      <main id="main">
        <ScreenFallback state={state} />
      </main>
    );
  const { bundle, sharingLevel } = state.data;

  if (bundle === null) {
    return (
      <main id="main">
        <h2>Coverage</h2>
        <section className="panel">
          <p>
            Coverage detail is not published at the <code>{sharingLevel}</code> sharing level. The
            local agent evaluated it; the operator chose not to upload the bundle.
          </p>
          <p>
            Raise the sharing level, or read the bundle locally with{' '}
            <code>ictt-sentinel evidence export</code>.
          </p>
        </section>
      </main>
    );
  }

  const mode = assetModeOf(bundle);
  const verdict = verdictPanel(bundle);
  const claim = claimCopy(mode, verdict.claimMode);

  return (
    <main id="main">
      <h2>Coverage</h2>
      <section className="panel" aria-labelledby="claim-heading">
        <h3 id="claim-heading">
          {mode === 'native' ? 'Native remote — upper bound' : 'Canonical ERC20 — reconciliation'}
        </h3>
        <Pairs
          items={[
            ['Asset mode', mode],
            ['Claim', claim.headline],
            ['What this means', claim.detail],
            ['What this does not claim', claim.notClaimed],
            ['Coverage', `${verdict.coverage} — ${coverageCopy(verdict.coverage)}`],
            [
              'Reason codes',
              verdict.reasonCodes.length === 0 ? 'none' : verdict.reasonCodes.join(', '),
            ],
          ]}
        />
        {mode === 'native' ? <Caveat>{NATIVE_PANEL_CAVEAT}</Caveat> : null}
      </section>

      <RuleTable bundle={bundle} />

      <section className="panel" aria-labelledby="assumptions-heading">
        <h3 id="assumptions-heading">Assumptions and exclusions</h3>
        <Pairs
          items={[
            [
              'Assumptions',
              <ul key="a">
                {bundle.core.assurance.assumptions.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>,
            ],
            [
              'Exclusions',
              <ul key="e">
                {bundle.core.assurance.exclusions.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>,
            ],
            [
              'Non-goals',
              <ul key="n">
                {bundle.core.assurance.nonGoals.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>,
            ],
          ]}
        />
      </section>

      <Caveat>{COVERAGE_CAVEAT}</Caveat>
    </main>
  );
};
