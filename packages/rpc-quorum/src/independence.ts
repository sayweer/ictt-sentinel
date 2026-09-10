/**
 * Declared independence, checked against observed infrastructure.
 *
 * Quorum counts distinct trustDomains, but that metadata is written by the
 * operator. Two endpoints can be declared independent and still sit in front of
 * one upstream, in which case the quorum is satisfied by a single failure
 * domain wearing two names. This module compares what was declared against what
 * the endpoints actually point at.
 *
 * The signals are deliberately not equal in weight:
 *
 *   conclusive - a shared secret reference or an identical hostname is not a
 *                hint. It is the same endpoint listed twice, so the witnesses
 *                collapse into one and the independent count drops.
 *   heuristic  - a shared address or CNAME target is suggestive only. Unrelated
 *                providers share CDNs and anycast ranges, so this is reported
 *                and never allowed to move a verdict by itself.
 *
 * Neither half proves independence. A clean result here means nothing was
 * caught, not that the witnesses are independent (docs/INVARIANTS.md 9).
 */

/** What an operator claims about where an endpoint sits. */
export interface IndependenceClaim {
  readonly trustDomain: string;
  readonly providerGroup: string;
}

/**
 * Partition endpoints into failure domains.
 *
 * A shared trustDomain OR a shared providerGroup joins two endpoints, and the
 * relation is transitive: alpha/x, beta/y and alpha/y are one domain, not two.
 * Group order and the order inside a group follow the input, so a caller that
 * needs a stable representative sorts its own input.
 *
 * This is the single definition of the relation. Counting witnesses and picking
 * one witness per domain are different questions with the same answer
 * underneath, and two implementations of it would eventually disagree.
 */
export const independenceGroups = <T extends IndependenceClaim>(
  items: readonly T[],
): readonly (readonly T[])[] => {
  const components: { domains: Set<string>; providers: Set<string>; items: T[] }[] = [];
  for (const item of items) {
    const joined = components.filter(
      (c) => c.domains.has(item.trustDomain) || c.providers.has(item.providerGroup),
    );
    const merged = {
      domains: new Set([item.trustDomain]),
      providers: new Set([item.providerGroup]),
      items: [item],
    };
    for (const component of joined) {
      for (const domain of component.domains) merged.domains.add(domain);
      for (const provider of component.providers) merged.providers.add(provider);
      merged.items.push(...component.items);
      components.splice(components.indexOf(component), 1);
    }
    components.push(merged);
  }
  return components.map((c) => c.items);
};

/** One endpoint as declared, plus whatever its host actually resolved to. */
export interface EndpointCorrelationInput {
  readonly endpointId: string;
  readonly trustDomain: string;
  /** Name of the variable holding the URL. Never the URL itself. */
  readonly secretRef: string;
  /** Host of the resolved URL, or null when it was unavailable. */
  readonly hostname: string | null;
  /** Resolved addresses. Empty when resolution was unavailable. */
  readonly addresses: readonly string[];
  /** CNAME targets. Empty when resolution was unavailable. */
  readonly cnames: readonly string[];
}

export type CorrelationSignal =
  'same-secret-ref' | 'same-hostname' | 'shared-address' | 'shared-cname';

/** Signals that mean "one witness, two names" rather than "worth a look". */
export const CONCLUSIVE_SIGNALS: readonly CorrelationSignal[] = [
  'same-secret-ref',
  'same-hostname',
];

export interface CorrelationFinding {
  readonly signal: CorrelationSignal;
  /** True when the pair is one endpoint twice, not merely correlated. */
  readonly conclusive: boolean;
  readonly endpointIds: readonly [string, string];
  readonly trustDomains: readonly [string, string];
  /**
   * Digest of the shared value, never the value. A hostname or address is not
   * a credential by itself, but it identifies an operator's infrastructure and
   * doctor output is pasted into support threads (docs/SECURITY.md).
   */
  readonly sharedDigest: string;
}

export interface CorrelationResult {
  readonly findings: readonly CorrelationFinding[];
  /** Endpoint pairs that must be counted as a single witness. */
  readonly merges: readonly (readonly [string, string])[];
}

/** Lowest shared member, so the digest is stable across runs. */
const overlap = (a: readonly string[], b: readonly string[]): string | null => {
  const other = new Set(b);
  return a.filter((value) => other.has(value)).sort((x, y) => x.localeCompare(y))[0] ?? null;
};

/** Strongest signal only: a shared hostname already implies a shared address. */
const strongestSignal = (
  a: EndpointCorrelationInput,
  b: EndpointCorrelationInput,
): { readonly signal: CorrelationSignal; readonly value: string } | null => {
  if (a.secretRef === b.secretRef) return { signal: 'same-secret-ref', value: a.secretRef };
  if (a.hostname !== null && a.hostname === b.hostname)
    return { signal: 'same-hostname', value: a.hostname };
  const address = overlap(a.addresses, b.addresses);
  if (address !== null) return { signal: 'shared-address', value: address };
  const cname = overlap(a.cnames, b.cnames);
  if (cname !== null) return { signal: 'shared-cname', value: cname };
  return null;
};

/**
 * Compare every pair that was declared independent.
 *
 * Pairs inside one trustDomain are skipped: they already count as one witness,
 * so a correlation between them is expected rather than a finding. The hash is
 * injected so this package keeps no dependency on the evidence package and the
 * caller keeps one domain-separation convention.
 */
export const correlateEndpoints = (
  inputs: readonly EndpointCorrelationInput[],
  hash: (input: string) => string,
): CorrelationResult => {
  const ordered = [...inputs].sort((a, b) => a.endpointId.localeCompare(b.endpointId));
  const findings: CorrelationFinding[] = [];
  const merges: (readonly [string, string])[] = [];
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      const a = ordered[i];
      const b = ordered[j];
      if (a === undefined || b === undefined || a.trustDomain === b.trustDomain) continue;
      const match = strongestSignal(a, b);
      if (match === null) continue;
      const conclusive = CONCLUSIVE_SIGNALS.includes(match.signal);
      findings.push({
        signal: match.signal,
        conclusive,
        endpointIds: [a.endpointId, b.endpointId],
        trustDomains: [a.trustDomain, b.trustDomain],
        sharedDigest: hash(`${match.signal}|${match.value}`).slice(0, 16),
      });
      if (conclusive) merges.push([a.endpointId, b.endpointId]);
    }
  }
  return { findings, merges };
};
