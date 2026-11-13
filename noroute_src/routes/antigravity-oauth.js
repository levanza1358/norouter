import { sendError, sendJson } from '../lib/http.js';
import {
  antigravityOAuthStateStatus,
  cancelAntigravityOAuthState,
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
