import { readJson, sendError, sendJson } from '../lib/http.js';
import {
  antigravityOAuthStateStatus,
  cancelAntigravityOAuthState,
  completeAntigravityOAuth,
  startAntigravityOAuth,
} from '../lib/antigravity-oauth.js';
import { getProvider } from '../providers/index.js';

export function handleAntigravityOAuthStatus(req, res, state) {
  return sendJson(res, 200, { status: antigravityOAuthStateStatus(state) });
}

export function handleAntigravityOAuthCancel(req, res, state) {
  cancelAntigravityOAuthState(state);
  return sendJson(res, 200, { cancelled: true });
}

export async function handleAntigravityOAuthStart(req, res) {
  const provider = getProvider('antigravity');
  if (!provider?.oauth) return sendError(res, 404, 'Antigravity OAuth is not configured.');
  try {
    return sendJson(res, 200, await startAntigravityOAuth(provider));
  } catch (err) {
    if (err.code === 'EADDRINUSE') return sendError(res, 409, 'Antigravity OAuth callback port 1456 is already in use. Close that process and retry.');
    if (/^Antigravity login needs /.test(err.message)) return sendError(res, 409, err.message);
    return sendError(res, 502, 'Could not start Antigravity OAuth.');
  }
}

export async function handleAntigravityOAuthComplete(req, res) {
  const provider = getProvider('antigravity');
  if (!provider?.oauth) return sendError(res, 404, 'Antigravity OAuth is not configured.');
  let body;
  try {
    body = await readJson(req, 16 * 1024);
  } catch (err) {
    return sendError(res, err.status || 400, err.message);
  }
  try {
    return sendJson(res, 200, await completeAntigravityOAuth(provider, body.redirectUrl));
  } catch (err) {
    if (err.status) return sendError(res, err.status, err.message);
    return sendError(res, 502, 'Could not complete Antigravity login.');
  }
}
