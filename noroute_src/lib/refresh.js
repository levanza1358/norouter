import { refreshCodebuddyToken } from './codebuddy.js';

async function refreshCodexToken(provider, refreshToken) {
  const oauth = provider.oauth;
  if (!oauth?.tokenUrl || !refreshToken) return null;
  const response = await fetch(oauth.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_id: oauth.clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = {}; }
  if (!response.ok) {
    const combined = `${body.error || ''} ${body.error_description || ''} ${text}`.toLowerCase();
    const permanent = ['refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated', 'invalid_grant']
      .some((marker) => combined.includes(marker));
    return { error: permanent ? 'unrecoverable_refresh_error' : 'refresh_failed', code: body.error || '' };
  }
  if (!body.access_token) return { error: 'refresh_failed' };
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || '',
    expiresIn: Number(body.expires_in) || null,
    idToken: body.id_token || '',
  };
}

// Google's token endpoint only accepts form-encoded bodies, and the
// Antigravity client id/secret live in the environment rather than in the
// provider file. A dead refresh token answers `invalid_grant`, which no retry
// can fix.
async function refreshAntigravityToken(provider, refreshToken) {
  const oauth = provider.oauth;
  const clientId = process.env[oauth.clientIdEnv]?.trim();
  const clientSecret = process.env[oauth.clientSecretEnv]?.trim();
  if (!oauth?.tokenUrl || !clientId || !clientSecret || !refreshToken) return { error: 'refresh_failed' };

  const response = await fetch(oauth.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = {}; }
  if (!response.ok) {
    const combined = `${body.error || ''} ${body.error_description || ''} ${text}`.toLowerCase();
    const permanent = ['invalid_grant', 'invalid_client', 'unauthorized_client'].some((marker) => combined.includes(marker));
    return { error: permanent ? 'unrecoverable_refresh_error' : 'refresh_failed', code: body.error || '' };
  }
  if (!body.access_token) return { error: 'refresh_failed' };
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || '',
    expiresIn: Number(body.expires_in) || null,
    idToken: body.id_token || '',
  };
}

export async function refreshProviderToken(provider, refreshToken) {
  if (provider.id === 'codex') return refreshCodexToken(provider, refreshToken);
  if (provider.id === 'antigravity') return refreshAntigravityToken(provider, refreshToken);
  return refreshCodebuddyToken(provider, refreshToken);
}
