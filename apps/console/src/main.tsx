import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiClient } from './api/client.js';
import { App } from './ui/app.js';

/**
 * Browser entry.
 *
 * The only file that touches the DOM root and the only place a token is held.
 * `token` is a closure variable read by the client on every request: it is never
 * written to storage, never serialised into a URL and never passed to a logger,
 * so a reload loses it deliberately.
 *
 * The stylesheet is linked from `index.html` rather than imported here, so it
 * ships as a plain file that a reviewer can read and `style-src 'self'` can
 * cover without an inline exception.
 */

let token: string | null = null;

const client = new ApiClient({
  token: () => token,
  // Same-origin. The API is expected behind the same host that serves this
  // bundle, which is what lets the page ship `connect-src 'self'`.
  basePath: '',
});

const Root = (): ReturnType<typeof App> => {
  const [hasToken, setHasToken] = useState(false);
  return (
    <App
      client={client}
      hasToken={hasToken}
      setToken={(value: string) => {
        token = value === '' ? null : value;
        setHasToken(token !== null);
      }}
      nowMs={Date.now()}
      timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
    />
  );
};

const container = document.getElementById('root');
if (container === null) throw new Error('console root element is missing');
createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
