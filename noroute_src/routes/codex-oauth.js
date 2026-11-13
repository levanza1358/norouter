import { readJson, sendError, sendJson } from '../lib/http.js';
import {
  cancelOAuthState,
  completeCodexOAuth,
  oauthStateStatus,
  startCodexOAuth,
} from '../lib/codex-oauth.js';
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

export async function handleCodexOAuthComplete(req, res) {
  const provider = getProvider('codex');
  if (!provider?.oauth) return sendError(res, 404, 'Codex OAuth is not configured.');
  let body;
  try {
    body = await readJson(req, 16 * 1024);
  } catch (err) {
    return sendError(res, err.status || 400, err.message);
  }
  try {
    return sendJson(res, 200, await completeCodexOAuth(provider, body.redirectUrl));
  } catch (err) {
    if (err.status) return sendError(res, err.status, err.message);
    return sendError(res, 502, 'Could not complete Codex login.');
  }
}
