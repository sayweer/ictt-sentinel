/**
 * Routing.
 *
 * Hash routing, because the console is a static artifact that must work under
 * any path prefix a reverse proxy picks, with no server-side rewrite rule and no
 * deep-link 404s.
 *
 * The parser is total and validating: an unparseable or hostile fragment
 * resolves to `not-found`, never to a partially-filled route. Route parameters
 * become API path segments, so `..` and friends are rejected here, before they
 * can reach a URL.
 */

export const DEPLOYMENT_ID = /^[a-z0-9][a-z0-9._-]{0,126}$/;
export const DIGEST = /^[0-9a-f]{64}$/;

export type Route =
  | { readonly page: 'deployments' }
  | { readonly page: 'onboarding' }
  | { readonly page: 'overview'; readonly deploymentId: string }
  | { readonly page: 'coverage'; readonly deploymentId: string }
  | { readonly page: 'messages'; readonly deploymentId: string }
  | { readonly page: 'incidents'; readonly deploymentId: string }
  | { readonly page: 'evidence'; readonly deploymentId: string }
  | { readonly page: 'evidence-detail'; readonly deploymentId: string; readonly digest: string }
  | { readonly page: 'not-found' };

export type PageName = Route['page'];

/** Tabs shown inside one deployment, in the order an operator works through them. */
export const DEPLOYMENT_TABS = [
  { page: 'overview', label: 'Overview' },
  { page: 'coverage', label: 'Coverage' },
  { page: 'messages', label: 'Messages' },
  { page: 'incidents', label: 'Incidents' },
  { page: 'evidence', label: 'Evidence' },
] as const;

const NOT_FOUND: Route = { page: 'not-found' };

/**
 * Slash is deliberately excluded from the id grammar used in the hash, even
 * though the API tolerates it: allowing a separator inside a segment makes the
 * route ambiguous and the encoding easy to get wrong.
 */
export const parseRoute = (hash: string): Route => {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw === '' || raw === '/') return { page: 'deployments' };
  if (!raw.startsWith('/')) return NOT_FOUND;

  let segments: string[];
  try {
    segments = raw
      .slice(1)
      .split('/')
      .filter((s) => s !== '')
      .map((s) => decodeURIComponent(s));
  } catch {
    // A malformed percent-escape is a hostile or truncated link, not a page.
    return NOT_FOUND;
  }

  if (segments.length === 1 && segments[0] === 'onboarding') return { page: 'onboarding' };
  if (segments[0] !== 'd') return NOT_FOUND;

  const deploymentId = segments[1];
  if (deploymentId === undefined || !DEPLOYMENT_ID.test(deploymentId)) return NOT_FOUND;

  const tail = segments[2];
  if (tail === undefined) return { page: 'overview', deploymentId };
  if (tail === 'coverage') return { page: 'coverage', deploymentId };
  if (tail === 'messages') return { page: 'messages', deploymentId };
  if (tail === 'incidents') return { page: 'incidents', deploymentId };
  if (tail === 'evidence') {
    const digest = segments[3];
    if (digest === undefined) return { page: 'evidence', deploymentId };
    if (segments.length === 4 && DIGEST.test(digest)) {
      return { page: 'evidence-detail', deploymentId, digest };
    }
    return NOT_FOUND;
  }
  return NOT_FOUND;
};

/** Build a hash from a route. The inverse of `parseRoute`, asserted by test. */
export const routeHash = (route: Route): string => {
  switch (route.page) {
    case 'deployments':
      return '#/';
    case 'onboarding':
      return '#/onboarding';
    case 'overview':
      return `#/d/${encodeURIComponent(route.deploymentId)}`;
    case 'coverage':
    case 'messages':
    case 'incidents':
    case 'evidence':
      return `#/d/${encodeURIComponent(route.deploymentId)}/${route.page}`;
    case 'evidence-detail':
      return `#/d/${encodeURIComponent(route.deploymentId)}/evidence/${route.digest}`;
    case 'not-found':
      return '#/not-found';
  }
};

export const deploymentRoute = (
  page: (typeof DEPLOYMENT_TABS)[number]['page'],
  id: string,
): Route =>
  page === 'overview'
    ? { page: 'overview', deploymentId: id }
    : page === 'coverage'
      ? { page: 'coverage', deploymentId: id }
      : page === 'messages'
        ? { page: 'messages', deploymentId: id }
        : page === 'incidents'
          ? { page: 'incidents', deploymentId: id }
          : { page: 'evidence', deploymentId: id };

/** Document title. `ictt-sentinel` is the brand; `Sentinel` alone never is. */
export const documentTitle = (route: Route): string => {
  const suffix =
    route.page === 'deployments'
      ? 'Deployments'
      : route.page === 'onboarding'
        ? 'Onboarding'
        : route.page === 'not-found'
          ? 'Not found'
          : `${route.deploymentId} · ${route.page}`;
  return `ictt-sentinel — ${suffix}`;
};
