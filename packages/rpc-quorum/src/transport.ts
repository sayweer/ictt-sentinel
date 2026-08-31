import { RpcError, faultForJsonRpcError, faultForStatus, type RpcFault } from './errors.js';
import { assertSendable, type AllowedMethod } from './methods.js';

/**
 * Transport boundary.
 *
 * The transport is injected. This package builds and validates requests but does
 * not own a network client, which keeps the one place that talks to the outside
 * world explicit and lets the whole quorum layer be tested against recorded
 * transcripts instead of a live endpoint.
 */

export interface RpcRequest {
  readonly method: AllowedMethod;
  readonly params: readonly unknown[];
}

export interface RpcResponse {
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

export interface EndpointDescriptor {
  /** Stable identifier used in logs, metrics and evidence. Never a URL. */
  readonly id: string;
  /** Independence unit. Quorum counts distinct values of this, never URLs. */
  readonly trustDomain: string;
  readonly providerGroup: string;
  readonly role: 'primary' | 'secondary' | 'archive';
  readonly archiveDepth: 'full' | 'pruned' | 'unknown';
}

export interface Transport {
  readonly endpoint: EndpointDescriptor;
  send(request: RpcRequest, signal: AbortSignal): Promise<RpcResponse>;
}

export interface TransportPolicy {
  readonly requestTimeoutMs: number;
  readonly maxRetries: number;
  readonly retryBackoffMs: number;
  readonly maxResponseBytes: number;
  readonly maxJsonDepth: number;
  readonly maxLogRangeBlocks: number;
  /** Host allowlist. Empty means unrestricted, which production must not be. */
  readonly allowedHosts: readonly string[];
  /** Redirects are refused: a redirect can move a request to another host. */
  readonly followRedirects: false;
  readonly requireHttps: true;
}

export const DEFAULT_TRANSPORT_POLICY: TransportPolicy = {
  requestTimeoutMs: 10_000,
  maxRetries: 2,
  retryBackoffMs: 500,
  maxResponseBytes: 8 * 1024 * 1024,
  maxJsonDepth: 64,
  maxLogRangeBlocks: 2_000,
  allowedHosts: [],
  followRedirects: false,
  requireHttps: true,
};

const PRIVATE_PATTERNS: readonly RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, // link-local, including cloud metadata
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i, // unique local IPv6
  /^\[?fe80:/i,
  /\.local$/i,
  /^metadata\./i,
];

export interface UrlCheck {
  readonly ok: boolean;
  readonly fault?: RpcFault;
  readonly reason?: string;
}

/**
 * Validate an endpoint URL before it is ever used.
 *
 * Refuses plaintext, refuses private and link-local hosts, and refuses anything
 * outside the allowlist when one is configured. The metadata endpoint is the
 * specific target worth naming: an endpoint URL is operator-supplied, and a tool
 * that fetches whatever it is handed is an SSRF primitive.
 */
export const checkEndpointUrl = (raw: string, policy: TransportPolicy): UrlCheck => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, fault: 'insecure-url', reason: 'endpoint is not a valid URL' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, fault: 'insecure-url', reason: 'endpoint must use https' };
  }
  if (url.username !== '' || url.password !== '') {
    return {
      ok: false,
      fault: 'insecure-url',
      reason: 'credentials must not be embedded in the URL',
    };
  }
  const host = url.hostname;
  if (PRIVATE_PATTERNS.some((rx) => rx.test(host))) {
    return {
      ok: false,
      fault: 'host-not-allowed',
      reason: 'endpoint resolves to a private or link-local host',
    };
  }
  if (policy.allowedHosts.length > 0 && !policy.allowedHosts.includes(host)) {
    return {
      ok: false,
      fault: 'host-not-allowed',
      reason: 'endpoint host is not on the allowlist',
    };
  }
  return { ok: true };
};

/** Depth guard applied to a decoded response before it is trusted. */
export const jsonDepth = (value: unknown, depth = 0): number => {
  if (depth > 1000) return depth;
  if (Array.isArray(value)) {
    let max = depth;
    for (const v of value) max = Math.max(max, jsonDepth(v, depth + 1));
    return max;
  }
  if (typeof value === 'object' && value !== null) {
    let max = depth;
    for (const v of Object.values(value)) max = Math.max(max, jsonDepth(v, depth + 1));
    return max;
  }
  return depth;
};

/**
 * Send one request through a transport, applying the policy.
 *
 * Retries only transient faults, and only up to the configured bound. A
 * permanent fault is surfaced immediately rather than being retried into a
 * timeout that looks like a network problem.
 */
export const sendChecked = async (
  transport: Transport,
  request: RpcRequest,
  policy: TransportPolicy,
  sleep: (ms: number) => Promise<void>,
): Promise<unknown> => {
  assertSendable(request.method);
  const { id, trustDomain } = transport.endpoint;

  let lastFault: RpcFault = 'transport';
  let lastMessage = 'no attempt was made';

  for (let attempt = 0; attempt <= policy.maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, policy.requestTimeoutMs);
    try {
      const response = await transport.send(request, controller.signal);
      if (response.error !== undefined) {
        const fault = faultForJsonRpcError(response.error.code, response.error.message);
        if (!['timeout', 'rate-limited', 'server-error', 'transport'].includes(fault)) {
          throw new RpcError({
            fault,
            endpointId: id,
            trustDomain,
            message: response.error.message,
          });
        }
        lastFault = fault;
        lastMessage = response.error.message;
      } else {
        const depth = jsonDepth(response.result);
        if (depth > policy.maxJsonDepth) {
          throw new RpcError({
            fault: 'response-too-deep',
            endpointId: id,
            trustDomain,
            message: `response nesting depth ${String(depth)} exceeds the limit`,
          });
        }
        return response.result;
      }
    } catch (cause) {
      if (cause instanceof RpcError) throw cause;
      const aborted = controller.signal.aborted;
      lastFault = aborted ? 'timeout' : 'transport';
      lastMessage = aborted ? 'request timed out' : 'transport failure';
    } finally {
      clearTimeout(timer);
    }

    if (attempt < policy.maxRetries) {
      await sleep(policy.retryBackoffMs * 2 ** attempt);
    }
  }

  throw new RpcError({ fault: lastFault, endpointId: id, trustDomain, message: lastMessage });
};

export { faultForStatus };
