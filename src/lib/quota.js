import { fetchCodebuddyQuota } from './codebuddy.js';
import { parseCodexUsage } from './codex-usage.js';

const TIMEOUT_MS = 20_000;

async function fetchJson(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    const text = await response.text();
    if (text.length > 2 * 1024 * 1024) return { error: 'Quota response is too large.' };
    let body;
    try { body = JSON.parse(text); } catch { return { error: 'Quota endpoint returned invalid JSON.' }; }
    if (!response.ok) {
      const upstreamMessage = body?.error?.message || body?.message || body?.detail;
      return {
        ...body,
        upstreamError: body?.error && typeof body.error === 'object' ? body.error : null,
        error: typeof upstreamMessage === 'string'
          ? upstreamMessage
          : `Quota endpoint returned HTTP ${response.status}.`,
        status: response.status,
      };
    }
    return body;
  } catch (err) {
    return { error: err.name === 'AbortError' ? 'Quota endpoint timed out.' : 'Quota endpoint could not be reached.' };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchProviderQuota(provider, accessToken, account = {}) {
  if (provider.quota?.parser === 'codex') {
    const headers = {
      accept: 'application/json',
      'OpenAI-Beta': 'codex-1',
      originator: provider.headers?.originator || 'codex_cli_rs',
      authorization: `Bearer ${accessToken}`,
    };
    if (account.uid) headers['ChatGPT-Account-ID'] = account.uid;
    const override = provider.quota.urlEnv ? process.env[provider.quota.urlEnv]?.trim() : '';
    const body = await fetchJson(override || provider.quota.url, headers);
    if (body.error) return body;
    return parseCodexUsage(body);
  }
  return fetchCodebuddyQuota(provider, accessToken);
}
