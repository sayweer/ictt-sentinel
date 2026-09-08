import type { JSX, ReactNode } from 'react';
import type { Badge as BadgeModel, Tone } from '../model/verdict.js';
import { conditionCopy, type Condition, type ScreenState } from '../model/screen.js';

/**
 * Shared primitives.
 *
 * Two rules run through all of them:
 *
 *   Colour is never alone. A `Badge` renders a tone, a glyph AND a label, so the
 *   meaning survives greyscale, colour blindness and a screen reader. The glyph
 *   is `aria-hidden` because the label already says it.
 *
 *   Nothing is rendered as raw HTML. There is no `dangerouslySetInnerHTML` in
 *   this console; every string from the API - a token symbol, a rule id, a
 *   reason - goes through React's escaping, which is what makes hostile contract
 *   metadata inert.
 */

export const Badge = ({ badge }: { badge: BadgeModel }): JSX.Element => (
  <span className="badge" data-tone={badge.tone}>
    <span className="glyph" aria-hidden="true">
      {badge.glyph}
    </span>
    <span>{badge.label}</span>
  </span>
);

/**
 * A designed state block.
 *
 * Every non-ready screen renders one of these, and each carries a reason and a
 * remedy. A screen that shows a spinner and nothing else tells an operator that
 * something is happening while implying nothing is wrong.
 */
export const StateBlock = ({
  tone,
  title,
  reason,
  remedy,
  children,
}: {
  tone: Tone;
  title: string;
  reason: string;
  remedy: string | null;
  children?: ReactNode;
}): JSX.Element => (
  <section
    className="state"
    data-tone={tone}
    aria-labelledby={`state-${title.replace(/\W+/g, '-')}`}
  >
    <h2 id={`state-${title.replace(/\W+/g, '-')}`}>{title}</h2>
    <p>{reason}</p>
    {remedy === null ? null : <p className="remedy">{remedy}</p>}
    {children}
  </section>
);

export const ConditionBlock = ({ condition }: { condition: Condition }): JSX.Element => {
  const copy = conditionCopy(condition);
  return (
    <StateBlock tone={copy.tone} title={copy.title} reason={copy.reason} remedy={copy.remedy} />
  );
};

/**
 * Render the non-ready branches of a screen state.
 *
 * Returns `null` only for `ready`, so a caller cannot forget a state: if it is
 * not ready, something explanatory is always on screen.
 */
export const ScreenFallback = <T,>({ state }: { state: ScreenState<T> }): JSX.Element | null => {
  switch (state.kind) {
    case 'ready':
      return null;
    case 'loading':
      return (
        <StateBlock
          tone={state.slow ? 'unknown' : 'neutral'}
          title={state.slow ? 'Still waiting for the hosted API' : 'Loading'}
          reason={state.notice}
          remedy={state.remedy}
        >
          <p aria-live="polite" className="visually-hidden">
            {state.notice}
          </p>
        </StateBlock>
      );
    case 'not-configured':
      return (
        <StateBlock
          tone="neutral"
          title="Not configured"
          reason={state.notice}
          remedy={state.remedy}
        />
      );
    case 'empty':
      return (
        <StateBlock
          tone="neutral"
          title="Nothing to show"
          reason={state.notice}
          remedy={state.remedy}
        />
      );
    case 'failed':
      return (
        <StateBlock
          tone="unknown"
          title="The console could not load this"
          reason={state.notice}
          remedy={state.remedy}
        >
          <p className="remedy">
            This is a console problem and not a verdict about a deployment. Nothing on this page
            should be read as healthy.
          </p>
        </StateBlock>
      );
  }
};

export const Caveat = ({ children }: { children: ReactNode }): JSX.Element => (
  <p className="caveat">{children}</p>
);

export const Pairs = ({
  items,
}: {
  items: readonly (readonly [string, ReactNode])[];
}): JSX.Element => (
  <dl className="pairs">
    {items.map(([term, value]) => (
      <div key={term} style={{ display: 'contents' }}>
        <dt>{term}</dt>
        <dd>{value}</dd>
      </div>
    ))}
  </dl>
);

/**
 * A data table with a screen-reader summary.
 *
 * `summary` is the alternative for the table: a sentence that says what the rows
 * mean and how many there are, so a screen-reader user is not forced to walk a
 * grid to find out whether it is worth walking.
 */
export const Table = ({
  caption,
  summary,
  headers,
  children,
}: {
  caption: string;
  summary: string;
  headers: readonly string[];
  children: ReactNode;
}): JSX.Element => (
  <div className="scroll-x">
    <table>
      <caption>
        {caption}
        <span className="visually-hidden"> {summary}</span>
      </caption>
      <thead>
        <tr>
          {headers.map((h) => (
            <th key={h} scope="col">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  </div>
);

/**
 * A timeline with a text alternative.
 *
 * An ordered list rather than a styled div stack: the order is the meaning, and
 * `<ol>` is the only element that says so to assistive technology.
 */
export const Timeline = ({
  label,
  summary,
  items,
}: {
  label: string;
  summary: string;
  items: readonly { readonly key: string; readonly content: ReactNode }[];
}): JSX.Element => (
  <section aria-label={label}>
    <p className="visually-hidden">{summary}</p>
    <ol className="timeline">
      {items.map((i) => (
        <li key={i.key}>{i.content}</li>
      ))}
    </ol>
  </section>
);

/** A hash link. Never an absolute URL: the console has one origin by design. */
export const HashLink = ({
  to,
  children,
  current,
}: {
  to: string;
  children: ReactNode;
  current?: boolean;
}): JSX.Element => (
  <a href={to} {...(current === true ? { 'aria-current': 'page' as const } : {})}>
    {children}
  </a>
);
