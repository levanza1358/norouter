import { createHash, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';

import { createAccount } from './accounts.js';

const states = new Map();
const completed = new Map();
let callbackServer = null;
let callbackStarting = null;
const STATE_TTL_MS = 10 * 60_000;

function localHost(host) {
  const value = String(host || '').split(':')[0].toLowerCase();
  return value === '127.0.0.1' || value === 'localhost' || value === '::1';
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
      redirect_uri: `http://127.0.0.1:${provider.oauth.fixedPort}${provider.oauth.callbackPath}`,
      code_verifier: verifier,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token || !body.refresh_token) {
    throw new Error('Codex OAuth token exchange failed. Log in again.');
  }
  return body;
}

async function callback(req, res, provider) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  if (!localHost(req.headers.host) || url.pathname !== provider.oauth.callbackPath) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Invalid local OAuth callback.');
  }
  cleanup();
  const state = url.searchParams.get('state');
  const entry = state ? states.get(state) : null;
  if (!entry || entry.providerId !== provider.id) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('OAuth state expired or invalid.');
  }
  states.delete(state);
  const code = url.searchParams.get('code');
  if (!code) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('OAuth authorization was cancelled.');
  }
  try {
    const token = await exchange(provider, code, entry.verifier);
    const result = createAccount(provider.id, {
      label: 'ChatGPT OAuth',
      kind: 'access_token',
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expiresIn: token.expires_in,
    });
    if (result.error && result.status !== 409) throw new Error('Could not save the Codex account.');
    completed.set(entry.state, { createdAt: Date.now(), status: 'complete' });
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
    redirect_uri: `http://127.0.0.1:${provider.oauth.fixedPort}${provider.oauth.callbackPath}`,
    scope: provider.oauth.scope,
    code_challenge: challenge(verifier),
    code_challenge_method: provider.oauth.codeChallengeMethod,
    state,
    ...provider.oauth.extraParams,
  });
  return { authorizeUrl: `${provider.oauth.authorizeUrl}?${params}`, state };
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
