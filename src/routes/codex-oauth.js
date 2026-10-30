import { sendError, sendJson } from '../lib/http.js';
import { cancelOAuthState, oauthStateStatus, startCodexOAuth } from '../lib/codex-oauth.js';
import { getProvider } from '../providers/index.js';

export function handleCodexOAuthStatus(req, res, state) {
  return sendJson(res, 200, { status: oauthStateStatus(state) });
}

export function handleCodexOAuthCancel(req, res, state) {
  cancelOAuthState(state);
  return sendJson(res, 200, { cancelled: true });
}

export async function handleCodexOAuthStart(req, res) {
  const provider = getProvider('codex');
  if (!provider?.oauth) return sendError(res, 404, 'Codex OAuth is not configured.');
  try {
    return sendJson(res, 200, await startCodexOAuth(provider));
  } catch (err) {
    if (err.code === 'EADDRINUSE') return sendError(res, 409, 'Codex OAuth callback port 1455 is already in use. Close that process and retry.');
    return sendError(res, 502, 'Could not start Codex OAuth.');
  }
}
