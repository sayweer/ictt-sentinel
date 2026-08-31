import type { EndpointDescriptor, RpcRequest, RpcResponse, Transport } from '../src/transport.js';

/**
 * Deterministic fake transport.
 *
 * Every test in this package runs against recorded behaviour, never a live
 * endpoint: a CI run that depends on a public RPC tests the provider's uptime
 * rather than this code.
 */

export type Scripted =
  | { readonly kind: 'result'; readonly result: unknown }
  | { readonly kind: 'error'; readonly code: number; readonly message: string }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'throw'; readonly message: string };

export interface FakeOptions {
  readonly endpoint: EndpointDescriptor;
  /** Responses keyed by method, consumed in order; the last one repeats. */
  readonly script: Readonly<Record<string, readonly Scripted[]>>;
}

export class FakeTransport implements Transport {
  readonly endpoint: EndpointDescriptor;
  readonly calls: RpcRequest[] = [];
  readonly #script: Record<string, Scripted[]>;

  constructor(options: FakeOptions) {
    this.endpoint = options.endpoint;
    this.#script = Object.fromEntries(Object.entries(options.script).map(([k, v]) => [k, [...v]]));
  }

  send(request: RpcRequest, signal: AbortSignal): Promise<RpcResponse> {
    this.calls.push(request);
    const queue = this.#script[request.method];
    const next = queue === undefined ? undefined : queue.length > 1 ? queue.shift() : queue[0];
    if (next === undefined) {
      return Promise.resolve({ error: { code: -32601, message: 'the method does not exist' } });
    }
    switch (next.kind) {
      case 'result':
        return Promise.resolve({ result: next.result });
      case 'error':
        return Promise.resolve({ error: { code: next.code, message: next.message } });
      case 'throw':
        return Promise.reject(new Error(next.message));
      case 'timeout':
        // Resolve only when aborted, which is what a real timeout looks like.
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        });
    }
  }
}

export const endpoint = (
  id: string,
  trustDomain: string,
  over: Partial<EndpointDescriptor> = {},
): EndpointDescriptor => ({
  id,
  trustDomain,
  providerGroup: `${trustDomain}-prod`,
  role: 'primary',
  archiveDepth: 'unknown',
  ...over,
});

/** Sleep that resolves immediately, so retry backoff does not slow the suite. */
export const noSleep = (): Promise<void> => Promise.resolve();
