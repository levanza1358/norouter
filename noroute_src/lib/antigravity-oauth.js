import { randomUUID } from 'node:crypto';
import { arch, platform } from 'node:os';
import http from 'node:http';

import { createAccount, setAccountProject } from './accounts.js';
import { antigravityTier } from './antigravity-quota.js';
import { normalizePlan } from './plan.js';

const states = new Map();
const completed = new Map();
let callbackServer = null;
let callbackStarting = null;
const STATE_TTL_MS = 10 * 60_000;
const ONBOARD_ATTEMPTS = 10;
const ONBOARD_DELAY_MS = 5000;

function localHost(host) {
  const value = String(host || '').split(':')[0].toLowerCase();
  return value === '127.0.0.1' || value === 'localhost' || value === '::1';
}

function cleanup() {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [key, value] of states) if (value.createdAt < cutoff) states.delete(key);
  for (const [key, value] of completed) if (value.createdAt < cutoff) completed.delete(key);
}

// The Antigravity client secret is not ours, so it is never embedded in this
// repository. Both values must come from the environment.
function credentials(provider) {
  const clientId = String(process.env[provider.oauth.clientIdEnv] || '').trim();
  const clientSecret = String(process.env[provider.oauth.clientSecretEnv] || '').trim();
  if (!clientId || !clientSecret) {
    throw new Error(
      `Antigravity login needs ${provider.oauth.clientIdEnv} and ${provider.oauth.clientSecretEnv} in the environment.`,
    );
  }
  return { clientId, clientSecret };
}

function redirectUri(provider) {
  return `http://localhost:${provider.oauth.fixedPort}${provider.oauth.callbackPath}`;
}

// Cloud Code ties the session to a desktop client, so every Google call sends
// the IDE's user agent and the local-request marker.
function googleHeaders(provider, accessToken) {
  return {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    'user-agent': provider.oauth.loadCodeAssistUserAgent,
    'x-request-source': 'local',
  };
}

function clientMetadata() {
  const os = platform();
  const arm = arch() === 'arm64';
  const osType = os === 'darwin' ? (arm ? 2 : 1) : os === 'linux' ? (arm ? 4 : 3) : os === 'win32' ? 5 : 0;
  return { ideType: 9, platform: osType, pluginType: 2 };
}

async function exchange(provider, code) {
  const { clientId, clientSecret } = credentials(provider);
  const response = await fetch(provider.oauth.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri(provider),
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw new Error(body.error_description || 'Google rejected the authorization code. Log in again.');
  }
  return body;
}

async function userInfo(provider, accessToken) {
  const response = await fetch(`${provider.oauth.userInfoUrl}?alt=json`, {
    headers: { authorization: `Bearer ${accessToken}`, 'x-request-source': 'local' },
  });
  return response.ok ? response.json().catch(() => ({})) : {};
}

// A Cloud Code request is meaningless without a project, so the account is
// pinned to the one loadCodeAssist reports for this Google login.
async function loadProject(provider, accessToken) {
  const response = await fetch(provider.oauth.loadCodeAssistUrl, {
    method: 'POST',
    headers: googleHeaders(provider, accessToken),
    body: JSON.stringify({ metadata: clientMetadata() }),
  });
  if (!response.ok) return { projectId: '', tierId: 'legacy-tier', plan: 'unknown' };
  const body = await response.json().catch(() => ({}));
  const raw = body.cloudaicompanionProject;
  const projectId = String((typeof raw === 'object' && raw ? raw.id : raw) || '').trim();
  const tier = Array.isArray(body.allowedTiers)
    ? body.allowedTiers.find((item) => item?.isDefault && item.id)
    : null;
  // Antigravity logins always report `currentTier: free-tier`; the Google One
  // plan that bills the account is `paidTier`. The tier id is the language the
  // pool stores; plan.js maps free-tier/g1-plus-tier/g1-pro-tier/standard.
  return {
    projectId,
    tierId: tier ? tier.id.trim() : 'legacy-tier',
    plan: normalizePlan(antigravityTier(body)?.id),
  };
}

// New accounts get their project created asynchronously, so the callback must
// not wait for onboarding. Poll in the background and pin the project id onto
// the account once Google reports it.
async function onboardInBackground(provider, accessToken, tierId, accountId, knownProjectId) {
  for (let attempt = 0; attempt < ONBOARD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(provider.oauth.onboardUserUrl, {
        method: 'POST',
        headers: googleHeaders(provider, accessToken),
        body: JSON.stringify({ tierId, metadata: clientMetadata() }),
      });
      const body = await response.json().catch(() => ({}));
      if (body.done === true) {
        const raw = body.response?.cloudaicompanionProject;
        const projectId = String((typeof raw === 'object' && raw ? raw.id : raw) || '').trim();
        if (projectId && projectId !== knownProjectId) setAccountProject(accountId, projectId);
        return;
      }
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, ONBOARD_DELAY_MS));
  }
}

function donePage(projectId) {
  const note = projectId
    ? ''
    : '<p>Google has not assigned a Cloud Code project yet; onboarding continues in the background.</p>';
  return `<!doctype html><title>norouter</title><p>Antigravity login complete. You can close this tab.</p>${note}<script>window.close()</script>`;
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
  const denied = url.searchParams.get('error');
  if (denied) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end(url.searchParams.get('error_description') || 'Google login was cancelled.');
  }
  const code = url.searchParams.get('code');
  if (!code) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('OAuth authorization was cancelled.');
  }
  try {
    const token = await exchange(provider, code);
    if (!token.refresh_token) {
      throw new Error('Google did not return a refresh token. Log in again and keep offline access enabled.');
    }
    const profile = await userInfo(provider, token.access_token);
    const { projectId, tierId, plan } = await loadProject(provider, token.access_token);
    // Leave the label unset so the pool names the account from the provider
    // prefix (`ag_1`, `ag_2`, …) like every other import path. The Google email
    // is the account identity: a repeated login replaces that row's tokens
    // instead of adding a second account for the same person.
    const result = createAccount(provider.id, {
      kind: 'access_token',
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      uid: profile.email || '',
      projectId,
      plan,
    }, { prefix: provider.prefix, expiresIn: token.expires_in, updateExisting: true });
    if (result.error) throw new Error('Could not save the Antigravity account.');
    if (result.id) onboardInBackground(provider, token.access_token, tierId, result.id, projectId);
    completed.set(entry.state, { createdAt: Date.now(), status: 'complete' });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(donePage(projectId));
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

export async function startAntigravityOAuth(provider) {
  const { clientId } = credentials(provider);
  cleanup();
  await ensureCallbackServer(provider);
  const state = randomUUID();
  states.set(state, { state, providerId: provider.id, createdAt: Date.now() });
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri(provider),
    scope: provider.oauth.scopes.join(' '),
    state,
    access_type: 'offline',
    prompt: 'consent',
  });
  return { authorizeUrl: `${provider.oauth.authorizeUrl}?${params}`, state };
}

export function cancelAntigravityOAuthState(state) {
  const removed = states.delete(state);
  completed.delete(state);
  return removed;
}

export function antigravityOAuthStateStatus(state) {
  cleanup();
  if (states.has(state)) return 'pending';
  if (completed.has(state)) return completed.get(state).status;
  return 'unknown';
}
