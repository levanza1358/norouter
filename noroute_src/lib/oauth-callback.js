// Shared validation for the redirect link the browser ends on after an OAuth
// login. When the dashboard is not opened on the same machine as the server,
// the loopback callback cannot reach it; the operator pastes the final URL
// instead and the server redeems the code. Only the provider's own loopback
// callback is accepted, and the state must still exist in the pending map.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const MAX_URL_LENGTH = 4096;

function invalid(message) {
  return Object.assign(new Error(message), { status: 400, code: 'invalid_oauth_callback' });
}

export function parseOAuthRedirect(provider, raw) {
  const text = String(raw || '').trim();
  if (!text) throw invalid('Paste the login link from the browser address bar.');
  if (text.length > MAX_URL_LENGTH) throw invalid('That link is too long to be an OAuth callback.');

  let url;
  try {
    url = new URL(text);
  } catch {
    throw invalid('That is not a valid link. Paste the full callback URL from the browser address bar.');
  }

  const expected = `http://localhost:${provider.oauth.fixedPort}${provider.oauth.callbackPath}`;
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(host)
    || url.port !== String(provider.oauth.fixedPort)
    || url.pathname !== provider.oauth.callbackPath) {
    throw invalid(`That link does not match this login. Use the callback link starting with ${expected}.`);
  }

  const state = String(url.searchParams.get('state') || '').trim();
  if (!state) throw invalid('That link has no OAuth state. Copy the full callback URL.');
  return {
    state,
    code: String(url.searchParams.get('code') || '').trim(),
    error: String(url.searchParams.get('error') || '').trim(),
    errorDescription: String(url.searchParams.get('error_description') || '').trim(),
  };
}
