import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiFailure } from '../src/api/client.js';

/**
 * API client behaviour.
 *
 * The interesting assertions are the negative ones: which requests are never
 * sent, and what never appears in an error a screen will render.
 */

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const record = (digest: string) => ({
  deploymentId: 'acme-usdc',
  evidenceDigest: digest,
  sharingLevel: 'approved-full',
  verifyStatus: 'verified',
  protocolStatus: 'OK',
  dataStatus: 'COMPLETE',
  observedAt: '2026-06-01T00:00:00.000Z',
  expiresAt: '2026-06-01T01:00:00.000Z',
  receivedAt: '2026-06-01T00:00:01.000Z',
});

const client = (fetcher: typeof fetch, token: string | null = 'token-value-0123456789') =>
  new ApiClient({ token: () => token, fetcher });

describe('api client', () => {
  it('sends a bearer token, no cookies and no redirects, on its own origin', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ deployments: [], next: null }));
    await client(fetcher).deployments();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [input, init] = fetcher.mock.calls[0]!;
    // A string, not a Request or a URL: the client builds same-origin paths.
    expect(typeof input).toBe('string');
    const url = input as string;
    expect(url).toBe('/v1/deployments');
    expect(url).not.toMatch(/^https?:/);
    expect(init?.headers).toMatchObject({ authorization: 'Bearer token-value-0123456789' });
    expect(init?.credentials).toBe('omit');
    expect(init?.mode).toBe('same-origin');
    expect(init?.redirect).toBe('error');
    // The token is a header and never a query parameter.
    expect(url).not.toContain('token-value');
  });

  it('refuses an absolute base path at construction', () => {
    for (const basePath of ['https://collector.example.com', '//evil.example', '/a/../b']) {
      expect(() => new ApiClient({ token: () => 't', basePath })).toThrow();
    }
    expect(() => new ApiClient({ token: () => 't', basePath: '/api' })).not.toThrow();
  });

  it('makes no request at all without a token', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(client(fetcher, null).deployments()).rejects.toBeInstanceOf(ApiFailure);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('maps each authorization outcome to a distinct remedy', async () => {
    const cases = [
      [401, 'unauthorized'],
      [403, 'forbidden'],
      [404, 'not-found'],
      [429, 'rate-limited'],
      [500, 'server'],
    ] as const;
    for (const [status, kind] of cases) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({}, status));
      const error = await client(fetcher)
        .status('acme-usdc')
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiFailure);
      expect((error as ApiFailure).kind).toBe(kind);
      expect((error as ApiFailure).remedy.length).toBeGreaterThan(0);
    }
  });

  it('never lets a transport error carry the URL or the token into a message', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('connect ECONNREFUSED /v1/deployments token-value-0123456789'));
    const error = (await client(fetcher)
      .deployments()
      .catch((e: unknown) => e)) as ApiFailure;
    expect(error.kind).toBe('network');
    expect(error.message).not.toContain('token-value');
    expect(error.message).not.toContain('/v1/deployments');
    // An unreachable API is a console problem, and the remedy says so.
    expect(error.remedy).toContain('Local evaluation and alerting are unaffected');
  });

  it('rejects a traversal-shaped deployment id without issuing a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const id of ['../../etc/passwd', 'ACME', 'a'.repeat(200), 'acme/../other']) {
      await expect(client(fetcher).status(id)).rejects.toBeInstanceOf(ApiFailure);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects a digest that is not a sha256 before requesting it', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(client(fetcher).evidenceDetail('acme-usdc', '../secrets')).rejects.toBeInstanceOf(
      ApiFailure,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses a response that is not JSON, and one that does not match the contract', async () => {
    const html = new Response('<html>login</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    const wrongShape = json({ deployments: [{ deploymentId: 'ACME UPPER' }], next: null });
    for (const response of [html, wrongShape]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      const error = (await client(fetcher)
        .deployments()
        .catch((e: unknown) => e)) as ApiFailure;
      expect(error.kind).toBe('contract');
    }
  });

  it('decodes the contract it is given', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        schemaVersion: 'ictt-sentinel/hosted-api/v1',
        items: [record('a'.repeat(64))],
        next: null,
      }),
    );
    const page = await client(fetcher).verdicts('acme-usdc');
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.evidenceDigest).toBe('a'.repeat(64));
    expect(fetcher.mock.calls[0]?.[0]).toBe('/v1/deployments/acme-usdc/verdicts');
  });

  it('reports a null status rather than inventing one', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ status: null }));
    await expect(client(fetcher).status('acme-usdc')).resolves.toBeNull();
  });
});
