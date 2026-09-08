import { createServer, type Server } from 'node:http';
import { handleObserve, type ObserveContext } from './observe.js';

/**
 * Thin `node:http` shim over `handleObserve`.
 *
 * Kept deliberately small and free of logic: every answer comes from the pure
 * handler, so what the probes see and what the tests assert cannot drift apart.
 *
 * Bound to loopback by default. This socket exposes health and metrics; it
 * accepts no input beyond a path, has no mutating route, and reads nothing from
 * the request body.
 */

export interface ObserveServerOptions {
  readonly host: string;
  readonly port: number;
  readonly context: () => ObserveContext;
}

export const createObserveServer = (options: ObserveServerOptions): Server => {
  const server = createServer((req, res) => {
    // Only GET and HEAD. There is nothing here to POST to, and saying so is
    // cheaper than discovering later that something accepted a body.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'GET, HEAD' });
      res.end('{"error":"method-not-allowed"}\n');
      return;
    }
    // Path only: query strings are ignored rather than parsed, and a malformed
    // request-target answers 400 instead of reaching the router.
    let path: string;
    try {
      path = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":"bad-request"}\n');
      return;
    }
    const answer = handleObserve(path, options.context());
    res.writeHead(answer.status, {
      'content-type': answer.contentType,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : answer.body);
  });

  // A probe that stalls must not hold a socket open forever.
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  return server;
};
