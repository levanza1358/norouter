// Upstream model catalog fetch shared by the manual "fetch models" action and
// the maintenance scheduler. Codex publishes a per-account catalog, so each
// account is queried with its own credential and the result is saved against it.
import { accessTokenFor } from './accounts.js';
import { saveCodexAccountCatalog } from './codex-account.js';
import { chatUrl } from '../providers/index.js';

export const CATALOG_TIMEOUT_MS = 20000;

// The /models URL: an explicit modelsPath is appended to the base URL (or its
// env override); providers without one derive it by trimming the chat path.
export function catalogUrl(provider) {
  const override = provider.baseUrlEnv ? process.env[provider.baseUrlEnv]?.trim() : '';
  const base = provider.modelsPath
    ? (override || provider.baseUrl).replace(/\/+$/, '')
    : chatUrl(provider).replace(/\/chat\/completions\/?$/, '').replace(/\/responses\/?$/, '');
  const modelUrl = `${base}${provider.modelsPath || '/models'}`;
  return provider.clientVersion ? `${modelUrl}?client_version=${encodeURIComponent(provider.clientVersion)}` : modelUrl;
}

export async function fetchCatalogForAccount(provider, row, url) {
  const credential = await accessTokenFor(provider, row);
  if (!credential.token) return { accountId: row.id, label: row.label, error: 'No usable account token.' };
  const headers = { accept: 'application/json', ...provider.headers, authorization: `Bearer ${credential.token}` };
  if (provider.id === 'codex') {
    headers['OpenAI-Beta'] = 'codex-1';
    headers.originator = provider.headers?.originator || 'codex_cli_rs';
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS);
  try {
    const upstream = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    const text = await upstream.text();
    if (!upstream.ok) return { accountId: row.id, label: row.label, status: upstream.status, error: `Provider answered ${upstream.status}.` };
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return { accountId: row.id, label: row.label, error: 'Provider returned invalid JSON.' };
    }
    const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : Array.isArray(payload?.items) ? payload.items : [];
    const ids = list.map((item) => (typeof item === 'string' ? item : item?.id || item?.model || item?.slug)).filter((id) => typeof id === 'string' && id.trim());
    if (!ids.length) return { accountId: row.id, label: row.label, error: 'Provider returned no models.' };
    const plan = payload.plan_type || payload.plan || payload.summary?.plan || row.plan || 'unknown';
    const saved = saveCodexAccountCatalog(row.id, plan, ids);
    return { accountId: row.id, label: row.label, plan: saved.plan, models: saved.models };
  } catch (err) {
    return { accountId: row.id, label: row.label, error: err.name === 'AbortError' ? 'Provider request timed out.' : 'Provider could not be reached.' };
  } finally {
    clearTimeout(timer);
  }
}
