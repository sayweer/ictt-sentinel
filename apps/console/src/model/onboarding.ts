/**
 * Onboarding review.
 *
 * The console **cannot approve anything**, and this module is where that is
 * enforced rather than merely intended. Baseline legitimacy comes from a human
 * reading a diff and running `ictt-sentinel doctor`; a browser that could flip a
 * candidate to approved would move that decision to whoever can reach the page
 * (docs/ARCHITECTURE.md 9).
 *
 * What the page does is narrow and useful: an operator pastes the JSON that
 * `ictt-sentinel discover --json` printed, and this module summarises it -
 * candidate remotes, which environment variables the draft REFERS to, and
 * whether the declared endpoints actually look independent.
 *
 * Two things keep a secret value off the screen. The first is structural: the
 * summary is built from an ALLOWLIST of named fields - id, role, trust domain,
 * provider group, archive depth, secretRef - so there is no code path that
 * renders an arbitrary value, whatever the pasted document contains.
 *
 * The second is a refusal. A discovery draft carries environment variable NAMES
 * by construction, so a URL, a DSN or a bearer-shaped string anywhere in it means
 * the operator pasted the wrong document, and the right response is to refuse the
 * input rather than summarise it (CLAUDE.md 3).
 *
 * This is a display-side shape check, not a second copy of the configuration
 * rule: the authoritative one is `findInlineSecrets` in `@ictt-sentinel/config`,
 * which the CLI runs. Importing it here would pull `node:crypto` into a browser
 * bundle, so the console keeps its own, narrower guard and says so.
 */

/**
 * Value shapes that must never appear in a document pasted into a browser.
 *
 * Narrow on purpose. A discovery draft is FULL of long hex strings - blockchain
 * ids, addresses, code hashes - so a generic "long opaque string" or "0x plus 64
 * hex" rule would refuse every legitimate draft and make the feature useless
 * while looking strict. What is listed here has no innocent reading inside a
 * manifest: a URL, an authorization header, embedded basic-auth credentials, or
 * a PEM key block.
 */
const SECRET_SHAPES: readonly { readonly name: string; readonly rx: RegExp }[] = [
  { name: 'url', rx: /\b[a-z][a-z0-9+.-]*:\/\/\S/i },
  { name: 'bearer', rx: /\bBearer\s+\S/i },
  { name: 'basic-auth', rx: /\b[A-Za-z0-9._%-]+:[^\s@/"']+@[A-Za-z0-9.-]+/ },
  { name: 'private-key-block', rx: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

export class PastedSecretError extends Error {
  override readonly name = 'PastedSecretError';
  /** Field paths only. A refusal must never echo the value it refused. */
  readonly issues: readonly { readonly path: string; readonly shape: string }[];
  constructor(issues: readonly { readonly path: string; readonly shape: string }[]) {
    super(
      `refusing to read a pasted document containing ${String(issues.length)} credential-shaped value(s)`,
    );
    this.issues = issues;
  }
}

/** Walk every string in the document, reporting PATHS of suspicious values. */
const findSecretShapes = (
  value: unknown,
  path = '',
  found: { path: string; shape: string }[] = [],
): readonly { path: string; shape: string }[] => {
  if (typeof value === 'string') {
    for (const { name, rx } of SECRET_SHAPES) {
      if (rx.test(value)) {
        found.push({ path: path === '' ? '(root)' : path, shape: name });
        break;
      }
    }
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((v: unknown, i) => findSecretShapes(v, `${path}[${String(i)}]`, found));
    return found;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      findSecretShapes(v, path === '' ? k : `${path}.${k}`, found);
    }
  }
  return found;
};

export interface EndpointSummary {
  readonly endpointId: string;
  readonly trustDomain: string;
  readonly providerGroup: string;
  readonly role: string;
  readonly archiveDepth: string;
  /** The environment variable NAME. Never a value; there is no field for one. */
  readonly secretRef: string;
}

export interface ChainSummary {
  readonly name: string;
  readonly blockchainId: string;
  readonly endpoints: readonly EndpointSummary[];
  /** Distinct provider groups. Quorum counts these, never URLs. */
  readonly distinctProviderGroups: number;
  readonly distinctTrustDomains: number;
  /** Groups that appear on more than one endpoint: one witness, not two. */
  readonly sharedProviderGroups: readonly string[];
  readonly sharedTrustDomains: readonly string[];
}

export interface DiscoveryReview {
  readonly deploymentName: string;
  readonly assetMode: string;
  readonly chains: readonly ChainSummary[];
  /** Remotes the draft found. Candidates, never trusted by discovery alone. */
  readonly candidateRemotes: readonly string[];
  /** Every environment variable name the draft expects to exist. */
  readonly requiredSecretRefs: readonly string[];
}

const text = (value: unknown, fallback = 'unknown'): string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : fallback;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const duplicates = (values: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) repeated.add(v);
    seen.add(v);
  }
  return [...repeated].sort();
};

const endpointsOf = (chain: Record<string, unknown>): readonly EndpointSummary[] => {
  const raw = chain['endpoints'];
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 8).map((e: unknown, i): EndpointSummary => {
    const ep = record(e);
    return {
      endpointId: text(ep['id'], `endpoint-${String(i + 1)}`),
      trustDomain: text(ep['trustDomain']),
      providerGroup: text(ep['providerGroup']),
      role: text(ep['role']),
      archiveDepth: text(ep['archiveDepth']),
      secretRef: text(ep['secretRef']),
    };
  });
};

const chainSummary = (name: string, chain: Record<string, unknown>): ChainSummary => {
  const endpoints = endpointsOf(chain);
  const groups = endpoints.map((e) => e.providerGroup);
  const domains = endpoints.map((e) => e.trustDomain);
  return {
    name,
    blockchainId: text(chain['blockchainId']),
    endpoints,
    distinctProviderGroups: new Set(groups).size,
    distinctTrustDomains: new Set(domains).size,
    sharedProviderGroups: duplicates(groups),
    sharedTrustDomains: duplicates(domains),
  };
};

/**
 * Summarise a pasted discovery draft.
 *
 * Deliberately reports counts and collisions rather than a pass/fail verdict on
 * independence. The authoritative check is `ictt-sentinel doctor`, which applies
 * the transitive rule against the real policy; restating that rule in a browser
 * would be a second implementation of it, and two implementations of one rule
 * eventually disagree.
 */
export const reviewDiscovery = (pasted: string): DiscoveryReview => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(pasted);
  } catch {
    throw new SyntaxError('That is not the JSON that `ictt-sentinel discover --json` prints.');
  }
  const issues = findSecretShapes(parsed);
  if (issues.length > 0) throw new PastedSecretError(issues);

  const doc = record(parsed);
  const spec = record(doc['spec']);
  const metadata = record(doc['metadata']);
  const home = record(spec['home']);
  const remotes = Array.isArray(spec['remotes']) ? spec['remotes'].slice(0, 32) : [];

  const chains: ChainSummary[] = [];
  if (Object.keys(home).length > 0) {
    chains.push(chainSummary(text(home['name'], 'home'), record(home['chain'])));
  }
  for (const [i, r] of remotes.entries()) {
    const remote = record(r);
    chains.push(
      chainSummary(text(remote['name'], `remote-${String(i + 1)}`), record(remote['chain'])),
    );
  }

  return {
    deploymentName: text(metadata['name'], 'unnamed draft'),
    assetMode: text(record(spec['asset'])['mode']),
    chains,
    candidateRemotes: remotes.map((r: unknown, i) =>
      text(record(record(r)['tokenRemote'])['address'], `remote-${String(i + 1)}`),
    ),
    requiredSecretRefs: [
      ...new Set(chains.flatMap((c) => c.endpoints.map((e) => e.secretRef))),
    ].sort(),
  };
};

export interface ChecklistItem {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  /** The command an operator runs. The console never runs it for them. */
  readonly command: string | null;
}

/**
 * The baseline review checklist.
 *
 * Step 4 is the one that matters: approval is a human act performed against a
 * diff, outside this browser. Everything before it prepares that decision and
 * everything after it depends on it having been made honestly.
 */
export const BASELINE_CHECKLIST: readonly ChecklistItem[] = [
  {
    id: 'init',
    title: 'Create the manifest skeleton',
    detail: 'Writes no secret and asks for none.',
    command: 'ictt-sentinel init',
  },
  {
    id: 'secrets',
    title: 'Put the RPC URLs in your own secret manager',
    detail:
      'The manifest records the environment variable NAME. The value never enters the repository, this console, or an evidence bundle.',
    command: null,
  },
  {
    id: 'discover',
    title: 'Produce a candidate draft and a diff',
    detail:
      'Discovery proposes. It approves nothing, and a permissionlessly registered remote stays a candidate.',
    command: 'ictt-sentinel discover --manifest deployment.yml --policy policy.yml --json',
  },
  {
    id: 'approve',
    title: 'Review the diff with an operator and an auditor, then approve it by hand',
    detail:
      'Baseline legitimacy is created here, by people. The current on-chain state is not automatically the correct baseline, and this page cannot approve it for you.',
    command: null,
  },
  {
    id: 'doctor',
    title: 'Check readiness',
    detail:
      'Verifies chain identity, bytecode fingerprints, archive depth, finality policy and which environment variables are missing. Reports secret PRESENCE, never a value.',
    command: 'ictt-sentinel doctor --manifest deployment.yml --policy policy.yml',
  },
  {
    id: 'replay',
    title: 'Replay from the deployment block',
    detail: 'A bounded, pinned, resumable replay. The result is PASS, VIOLATION or UNKNOWN.',
    command: 'ictt-sentinel replay --manifest deployment.yml --policy policy.yml',
  },
  {
    id: 'evidence',
    title: 'Export an evidence bundle and attach it to your release gate',
    detail: 'Reproducible and audit-shareable. Verify it offline with the CLI, not in a browser.',
    command: 'ictt-sentinel evidence export --manifest deployment.yml --policy policy.yml',
  },
  {
    id: 'share',
    title: 'Decide what may leave the machine',
    detail:
      'The default is local-only and enabling the hosted plane does not change it. Raising the level is an explicit act.',
    command: null,
  },
];

/** Stated on the page so nobody has to infer it from a missing button. */
export const NO_APPROVAL_IN_BROWSER =
  'This console is read-only. It cannot approve a baseline, register a remote, pause a contract or send a transaction, and it holds no key that could.' as const;
