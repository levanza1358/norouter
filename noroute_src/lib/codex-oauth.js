import { createHash, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';

import { createAccount } from './accounts.js';
import { identityFromToken } from './account-identity.js';
import { parseOAuthRedirect } from './oauth-callback.js';

const states = new Map();
const completed = new Map();
let callbackServer = null;
let callbackStarting = null;
const STATE_TTL_MS = 10 * 60_000;

function localHost(host) {
  const value = String(host || '').split(':')[0].toLowerCase();
  return value === '127.0.0.1' || value === 'localhost' || value === '::1';
}

function redirectUri(provider) {
  return `http://127.0.0.1:${provider.oauth.fixedPort}${provider.oauth.callbackPath}`;
}

function base64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function challenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

function cleanup() {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [key, value] of states) if (value.createdAt < cutoff) states.delete(key);
  for (const [key, value] of completed) if (value.createdAt < cutoff) completed.delete(key);
}

async function exchange(provider, code, verifier) {
  const response = await fetch(provider.oauth.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      client_id: provider.oauth.clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(provider),
      code_verifier: verifier,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token || !body.refresh_token) {
    throw Object.assign(new Error('Codex OAuth token exchange failed. Log in again.'), { status: 400 });
  }
  return body;
}

function takeState(provider, state) {
  cleanup();
  const entry = state ? states.get(state) : null;
  if (!entry || entry.providerId !== provider.id) {
    throw Object.assign(new Error('OAuth state expired or invalid. Start the login again.'), { status: 400 });
  }
  states.delete(state);
  return entry;
}

// Exchange the code and save the account. The loopback callback and the
// pasted-link fallback both end here, so token handling stays in one place.
async function redeem(provider, entry, code) {
  const token = await exchange(provider, code, entry.verifier);
  // Codex carries the account id and plan in the id_token; the access token
  // holds the same claim. Capturing it here is what lets a re-login update
  // its own row instead of adding a second account for the same person.
  const identity = identityFromToken(token.id_token) || identityFromToken(token.access_token);
  // Leave the label unset so the pool names the account from the provider
  // prefix (`cx_1`, `cx_2`, …) like every other import path.
  const result = createAccount(provider.id, {
    kind: 'access_token',
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    uid: identity?.uid || '',
    plan: identity?.plan || 'unknown',
  }, { prefix: provider.prefix, expiresIn: token.expires_in, updateExisting: true });
  if (result.error) throw Object.assign(new Error('Could not save the Codex account.'), { status: 400 });
  completed.set(entry.state, { createdAt: Date.now(), status: 'complete' });
}

async function callback(req, res, provider) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  if (!localHost(req.headers.host) || url.pathname !== provider.oauth.callbackPath) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Invalid local OAuth callback.');
  }
  let entry;
  try {
    entry = takeState(provider, url.searchParams.get('state'));
  } catch (err) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end(err.message);
  }
  const denied = url.searchParams.get('error');
  if (denied) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end(url.searchParams.get('error_description') || 'Codex login was cancelled.');
  }
  const code = url.searchParams.get('code');
  if (!code) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('OAuth authorization was cancelled.');
  }
  try {
    await redeem(provider, entry, code);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><title>norouter</title><p>Codex login complete. You can close this tab.</p><script>window.close()</script>');
  } catch (err) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end(err.message);
  }
}

async function ensureCallbackServer(provider) {
  if (callbackServer?.listening) return;
  if (callbackStarting) return callbackStarting;
  callbackStarting = new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => callback(req, res, provider));
    server.once('error', reject);
    server.listen(provider.oauth.fixedPort, '127.0.0.1', () => {
      callbackServer = server;
      resolve();
    });
  }).finally(() => { callbackStarting = null; });
  return callbackStarting;
}

export async function startCodexOAuth(provider) {
  cleanup();
  await ensureCallbackServer(provider);
  const verifier = base64url(randomBytes(32));
  const state = randomUUID();
  states.set(state, { state, providerId: provider.id, verifier, createdAt: Date.now() });
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: provider.oauth.clientId,
    redirect_uri: redirectUri(provider),
    scope: provider.oauth.scope,
    code_challenge: challenge(verifier),
    code_challenge_method: provider.oauth.codeChallengeMethod,
    state,
    ...provider.oauth.extraParams,
  });
  return { authorizeUrl: `${provider.oauth.authorizeUrl}?${params}`, state, callbackUrl: redirectUri(provider) };
}

// Manual fallback for a browser that cannot reach the loopback callback (for
// example a dashboard running on another machine). The pasted URL is validated
// against this provider's callback, and the state must still be pending.
export async function completeCodexOAuth(provider, redirectUrl) {
  const params = parseOAuthRedirect(provider, redirectUrl);
  const entry = takeState(provider, params.state);
  if (params.error) {
    throw Object.assign(new Error(params.errorDescription || 'Codex login was cancelled.'), { status: 400 });
  }
  if (!params.code) {
    throw Object.assign(new Error('That link has no authorization code. Copy the full callback URL.'), { status: 400 });
  }
  await redeem(provider, entry, params.code);
  return { status: 'complete' };
}

export function cancelOAuthState(state) {
  const removed = states.delete(state);
  completed.delete(state);
  return removed;
}

export function oauthStateStatus(state) {
  cleanup();
  if (states.has(state)) return 'pending';
  if (completed.has(state)) return completed.get(state).status;
  return 'unknown';
}

export function oauthStateCount() {
  cleanup();
  return states.size;
}
