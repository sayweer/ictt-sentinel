import {
  ContractError,
  deploymentId as checkDeploymentId,
  evidenceDetail,
  evidenceListResponse,
  listDeployments,
  messagesResponse,
  statusResponse,
  timelineResponse,
} from './decode.js';
import type {
  DeploymentGrant,
  DeploymentStatus,
  EvidenceDetailResponse,
  EvidenceRecord,
  MessageRow,
} from './contract.js';

/**
 * The console's only way to reach anything.
 *
 * Three deliberate absences: there is no RPC method here, no wallet or signer,
 * and no configurable host. The base path is same-origin by construction, which
 * is what lets the page ship `connect-src 'self'` and what stops a compromised
 * build - or a hostile query string - from pointing the console at a collector
 * (docs/adr/0009-console-stack.md).
 *
 * The token lives in memory for the lifetime of the tab and nowhere else: not in
 * `localStorage`, not in a cookie this code sets, not in a URL, and not in any
 * log line. Session storage would survive an XSS long enough to be stolen; the
 * cost of retyping it after a reload is the price of that.
 */

export type FailureKind =
  'unauthorized' | 'forbidden' | 'not-found' | 'rate-limited' | 'contract' | 'network' | 'server';

export class ApiFailure extends Error {
  override readonly name = 'ApiFailure';
  readonly kind: FailureKind;
  /** Operator-facing next step. Never contains a token, a URL or server text. */
  readonly remedy: string;
  constructor(kind: FailureKind, message: string, remedy: string) {
    super(message);
    this.kind = kind;
    this.remedy = remedy;
  }
}

const FAILURES: Readonly<Record<FailureKind, { message: string; remedy: string }>> = {
  unauthorized: {
    message: 'The API rejected this session token.',
    remedy: 'Enter a current token. Tokens expire; ask an operator to issue a new one.',
  },
  forbidden: {
    message: 'This token does not carry the scope this page needs.',
    remedy: 'A token needs status:read for verdicts and evidence:read for bundles.',
  },
  'not-found': {
    message: 'No such deployment for this tenant.',
    remedy: 'Check the deployment id, or confirm your tenant has been granted access to it.',
  },
  'rate-limited': {
    message: 'The API is rate limiting this session.',
    remedy: 'Wait for the current minute to end before reloading.',
  },
  contract: {
    message: 'The API returned something this console version does not understand.',
    remedy: 'The console and the API are probably different versions. Check /openapi.json.',
  },
  network: {
    message: 'The API could not be reached.',
    remedy: 'This is a console-to-API problem. Local evaluation and alerting are unaffected.',
  },
  server: {
    message: 'The API reported an internal error.',
    remedy: 'Check the API service logs. Nothing on this page is a verdict about a deployment.',
  },
};

const failure = (kind: FailureKind): ApiFailure =>
  new ApiFailure(kind, FAILURES[kind].message, FAILURES[kind].remedy);

export interface ClientOptions {
  /** In-memory only. Read on each request so a re-entry takes effect at once. */
  readonly token: () => string | null;
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
  /**
   * Same-origin path prefix, e.g. `/api`. Never an absolute URL: a host here
   * would be an exfiltration channel and would break the page's CSP.
   */
  readonly basePath?: string;
}

const MAX_BYTES = 8 * 1024 * 1024;

export class ApiClient {
  readonly #options: ClientOptions;
  readonly #base: string;

  constructor(options: ClientOptions) {
    const base = options.basePath ?? '';
    if (base !== '' && (!base.startsWith('/') || base.includes('//') || base.includes('..'))) {
      throw new Error('basePath must be a same-origin path prefix');
    }
    this.#options = options;
    this.#base = base.replace(/\/$/, '');
  }

  async #get(path: string, query: Readonly<Record<string, string>> = {}): Promise<unknown> {
    const token = this.#options.token();
    if (token === null || token === '') throw failure('unauthorized');

    const search = new URLSearchParams(query).toString();
    const url = `${this.#base}${path}${search === '' ? '' : `?${search}`}`;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#options.timeoutMs ?? 15_000);

    let response: Response;
    try {
      response = await (this.#options.fetcher ?? fetch)(url, {
        method: 'GET',
        // Same-origin only, and no ambient cookies: authorization is the bearer
        // header alone, so a CSRF against this console has nothing to ride on.
        mode: 'same-origin',
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        headers: { accept: 'application/json', authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
    } catch {
      // Never rethrows the transport error: its message can contain the URL,
      // and on some engines the request headers with it.
      throw failure('network');
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401) throw failure('unauthorized');
    if (response.status === 403) throw failure('forbidden');
    if (response.status === 404) throw failure('not-found');
    if (response.status === 429) throw failure('rate-limited');
    if (!response.ok) throw failure('server');

    const type = response.headers.get('content-type') ?? '';
    if (!type.startsWith('application/json')) throw failure('contract');
    const body = await response.text();
    if (body.length > MAX_BYTES) throw failure('contract');
    try {
      return JSON.parse(body);
    } catch {
      throw failure('contract');
    }
  }

  async #decode<T>(
    path: string,
    decode: (value: unknown) => T,
    query?: Record<string, string>,
  ): Promise<T> {
    const body = await this.#get(path, query);
    try {
      return decode(body);
    } catch (e) {
      if (e instanceof ContractError) throw failure('contract');
      throw e;
    }
  }

  /**
   * Path segment for a deployment.
   *
   * Validated against the id grammar and then percent-encoded. Both, not either:
   * validation rejects `..` before it can be encoded into something a proxy
   * might normalise back.
   */
  static segment(id: string): string {
    return encodeURIComponent(checkDeploymentId(id, 'deploymentId'));
  }

  /**
   * Every public method is `async`, so a rejected id or a bad digest arrives as
   * a rejected promise rather than a synchronous throw. One failure channel is
   * the difference between a screen showing a reason and a blank page.
   */
  async deployments(
    after?: string,
  ): Promise<{ items: readonly DeploymentGrant[]; next: string | null }> {
    return this.#decode('/v1/deployments', listDeployments, after === undefined ? {} : { after });
  }

  async status(id: string): Promise<DeploymentStatus | null> {
    return this.#decode(`/v1/deployments/${this.#segment(id)}/status`, statusResponse);
  }

  async verdicts(id: string): Promise<{ items: readonly EvidenceRecord[]; next: string | null }> {
    return this.#decode(`/v1/deployments/${this.#segment(id)}/verdicts`, timelineResponse);
  }

  async messages(id: string): Promise<readonly MessageRow[]> {
    return this.#decode(`/v1/deployments/${this.#segment(id)}/messages`, messagesResponse);
  }

  async evidence(id: string): Promise<{ items: readonly EvidenceRecord[]; next: string | null }> {
    return this.#decode(`/v1/deployments/${this.#segment(id)}/evidence`, evidenceListResponse);
  }

  async evidenceDetail(id: string, digest: string): Promise<EvidenceDetailResponse> {
    if (!/^[0-9a-f]{64}$/.test(digest)) throw failure('not-found');
    return this.#decode(`/v1/deployments/${this.#segment(id)}/evidence/${digest}`, evidenceDetail);
  }

  /** An id that fails the grammar becomes a 404, never a request. */
  #segment(id: string): string {
    try {
      return ApiClient.segment(id);
    } catch {
      throw failure('not-found');
    }
  }
}
