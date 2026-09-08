import type { Endpoint } from '@ictt-sentinel/config';
import {
  DEFAULT_TRANSPORT_POLICY,
  assertSendable,
  buildRequest,
  checkEndpointUrl,
  jsonDepth,
  type ReadOperation,
} from '@ictt-sentinel/rpc-quorum';
import type { EndpointRead } from './log-source.js';

/**
 * The agent's only outbound RPC path.
 *
 * Every request is built by `@ictt-sentinel/rpc-quorum` from a domain operation
 * and checked against the query-only allowlist before it leaves. There is no
 * function here that takes a method name, so no caller - and no future caller -
 * can send `eth_sendRawTransaction` through this (CLAUDE.md 3).
 *
 * The response is treated as hostile input: the URL is validated first, the
 * redirect is refused, the body is size-capped while streaming, and the decoded
 * JSON is depth-limited before anything looks at it.
 */

export class RpcUnavailable extends Error {
  override readonly name = 'RpcUnavailable';
}

export interface RpcOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs: number;
  readonly fetcher?: typeof fetch;
}

export const createEndpointReader = (options: RpcOptions): EndpointRead => {
  const fetcher = options.fetcher ?? fetch;

  return async (endpoint: Endpoint, operation: ReadOperation, signal: AbortSignal) => {
    const url = options.env[endpoint.secretRef];
    if (url === undefined || !checkEndpointUrl(url, DEFAULT_TRANSPORT_POLICY).ok) {
      // Never says which endpoint or why in a way that echoes the URL: this
      // message reaches logs.
      throw new RpcUnavailable('endpoint unavailable');
    }
    const request = buildRequest(operation);
    assertSendable(request.method);

    const timeout = new AbortController();
    const timer = setTimeout(() => {
      timeout.abort();
    }, options.timeoutMs);
    try {
      const response = await fetcher(url, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...request }),
        signal: AbortSignal.any([signal, timeout.signal]),
      });
      if (!response.ok || response.body === null) throw new RpcUnavailable('rpc unavailable');

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          const chunk: unknown = next.value;
          if (!(chunk instanceof Uint8Array)) throw new RpcUnavailable('invalid response chunk');
          length += chunk.byteLength;
          // Capped while streaming, not after: a provider that answers with a
          // gigabyte must cost us a few kilobytes, not a gigabyte.
          if (length > DEFAULT_TRANSPORT_POLICY.maxResponseBytes) {
            throw new RpcUnavailable('response too large');
          }
          chunks.push(chunk);
        }
      } finally {
        await reader.cancel();
      }

      const decoded: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (
        typeof decoded !== 'object' ||
        decoded === null ||
        Array.isArray(decoded) ||
        jsonDepth(decoded) > DEFAULT_TRANSPORT_POLICY.maxJsonDepth
      ) {
        throw new RpcUnavailable('rpc response rejected');
      }
      const body = decoded as Record<string, unknown>;
      if (
        body['jsonrpc'] !== '2.0' ||
        body['id'] !== 1 ||
        body['error'] !== undefined ||
        !('result' in body)
      ) {
        throw new RpcUnavailable('rpc response rejected');
      }
      return body['result'];
    } finally {
      clearTimeout(timer);
    }
  };
};
