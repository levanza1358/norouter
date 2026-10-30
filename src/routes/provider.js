import { accountCounts, accessTokenFor, getAccountRow, listAccounts, poolToken } from '../lib/accounts.js';
import { readJson, sendError, sendJson } from '../lib/http.js';
import { addCustomModel, customModels, modelEnabled, removeCustomModel, setModelEnabled } from '../lib/custom-models.js';
import { providerUsage, stats } from '../lib/stats.js';
import { testProviderModels } from '../lib/model-test.js';
import { modelCapability } from '../providers/model-capabilities.js';
import { catalogModels } from '../providers/index.js';
import { codexAccountIdByToken, codexActiveAccounts, codexModelAccounts, codexModelPlans, saveCodexAccountCatalog } from '../lib/codex-account.js';
import {
  addProvider,
  allModels,
  chatUrl,
  getProvider,
  removeProvider,
  updateProvider,
} from '../providers/index.js';

const FETCH_TIMEOUT_MS = 20000;

function getAccountModelCount(providerId, model) {
  return providerId === 'codex' ? codexModelAccounts(model).length : 0;
}

function budgetEnv(provider) {
  return `${provider.id.replace(/[^a-z0-9]/gi, '_').toUpperCase()}_TOKEN_BUDGET`;
}

function budgetFor(provider) {
  const key = budgetEnv(provider);
  const value = Number(process.env[key]);
  const limit = Number.isFinite(value) && value > 0 ? value : null;
  return { key, limit };
}

// Credentialed providers use only the SQLite account pool. Providers without
// a credential requirement are open endpoints.
function credentialState(provider, pool) {
  if (!provider.requiresAccount) return 'open';
  return pool.total > 0 ? 'pool' : 'missing';
}

export function providerSnapshot(provider) {
  const pool = accountCounts(provider.id);
  const custom = customModels(provider.id);
  const models = catalogModels(provider);
  const usage = providerUsage(provider.id);
  const budget = budgetFor(provider);
  const used = usage.tokensIn + usage.tokensOut;
  const override = provider.baseUrlEnv ? (process.env[provider.baseUrlEnv] || '').trim() : '';

  return {
    provider: {
      id: provider.id,
      prefix: provider.prefix,
      name: provider.display.name,
      website: provider.display.website,
      format: provider.format,
      modelDiscovery: provider.modelDiscovery !== false,
      modelsPath: provider.modelsPath || null,
      endpoint: chatUrl(provider),
      credential: credentialState(provider, pool),
      tokenEnv: provider.tokenEnv,
      models: models.length,
      custom: custom.length,
      modelsPath: provider.modelsPath || null,
      customProvider: Boolean(provider.custom),
      oauth: Boolean(provider.oauth),
      baseUrlEnv: provider.baseUrlEnv,
      config: {
        id: provider.id,
        prefix: provider.prefix,
        name: provider.display.name,
        website: provider.display.website || '',
        baseUrl: provider.baseUrl,
        chatPath: provider.chatPath,
        headers: { ...provider.headers },
        models: [...models],
        format: provider.format,
        forceStream: Boolean(provider.forceStream),
        requiresAccount: Boolean(provider.requiresAccount),
        baseUrlEnv: provider.baseUrlEnv || '',
        refresh: provider.refresh || null,
        quota: provider.quota || null,
        checkin: provider.checkin || null,
        reasoning: provider.reasoning || null,
        accountStrategy: provider.accountStrategy || 'round-robin',
      },
      // A non-empty override means the router is pointed at a test gateway,
      // which is the usual reason an endpoint looks wrong in the UI.
      endpointOverride: override,
      refreshSupported: Boolean(provider.refresh?.url),
      quotaSupported: Boolean(provider.quota?.url),
      reasoning: provider.reasoning || null,
    },
    pool,
    quota: {
      used,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      requests: usage.requests,
      errors: usage.errors,
      lastMs: usage.lastMs,
      lastError: usage.lastError,
      budget: budget.limit,
      budgetEnv: budget.key,
      percent: budget.limit ? Math.min(100, Math.round((used / budget.limit) * 100)) : null,
      note: provider.quota?.parser === 'codex'
        ? 'Codex quota comes from the ChatGPT WHAM usage endpoint. Windows may include session, weekly, review, and spark limits.'
        : provider.quota?.url
          ? 'Per-account quota comes from the provider billing endpoint; this bar counts traffic the router relayed since it started.'
          : `${provider.display.name} publishes no quota endpoint, so this counts traffic the router has relayed since it started.`,
    },
    models: models.map((id) => {
      const hit = stats.perModel.get(id);
      const plans = provider.id === 'codex' ? (codexModelPlans().get(id) || []) : [];
      return {
        id,
        source: custom.includes(id) && !plans.length ? 'custom' : 'catalog',
        plans,
        accountCount: plans.length ? getAccountModelCount(provider.id, id) : 0,
        requests: hit ? hit.requests : 0,
        tokensIn: hit ? hit.tokensIn : 0,
        tokensOut: hit ? hit.tokensOut : 0,
        lastMs: hit ? hit.lastMs : null,
        capabilities: modelCapability(provider.id, id),
        enabled: modelEnabled(provider.id, id),
      };
    }),
  };
}

function resolveProvider(res, rawId) {
  const provider = getProvider(decodeURIComponent(rawId));
  if (!provider) {
    sendError(res, 404, `Unknown provider "${rawId}"`);
    return null;
  }
  return provider;
}

export function handleProviderDetail(req, res, rawId) {
  const provider = resolveProvider(res, rawId);
  if (!provider) return undefined;
  return sendJson(res, 200, providerSnapshot(provider));
}

// Creates an [OI]-compatible provider from the dashboard. Accounts can be
// added afterwards; credentials stay in the SQLite account pool.
export async function handleCreateProvider(req, res) {
  let body;
  try {
    body = await readJson(req, 64 * 1024);
  } catch (err) {
    return sendError(res, err.status || 400, err.message);
  }

  const result = addProvider(body);
  if (result.error) return sendError(res, result.status || 400, result.error);

  return sendJson(res, 201, {
    created: result.provider.id,
    note: result.provider.requiresAccount
      ? 'Add an account on the provider page before sending requests.'
      : 'This provider needs no credential, so it is ready to serve.',
    ...providerSnapshot(result.provider),
  });
}

export async function handleUpdateProvider(req, res, rawId) {
  let body;
  try {
    body = await readJson(req, 64 * 1024);
  } catch (err) {
    return sendError(res, err.status || 400, err.message);
  }
  const id = decodeURIComponent(rawId);
  const result = updateProvider(id, body);
  if (result.error) return sendError(res, result.status || 400, result.error);
  return sendJson(res, 200, providerSnapshot(result.provider));
}

export function handleDeleteProvider(req, res, rawId) {
  const provider = resolveProvider(res, rawId);
  if (!provider) return undefined;
  if (!provider.custom) {
    return sendError(res, 400, `"${provider.id}" ships with the router. Remove its file in src/providers/ instead.`);
  }
  removeProvider(provider.id);
  return sendJson(res, 200, { removed: provider.id });
}

export async function handleAddModel(req, res, rawId) {
  const provider = resolveProvider(res, rawId);
  if (!provider) return undefined;

  let body;
  try {
    body = await readJson(req, 64 * 1024);
  } catch (err) {
    return sendError(res, err.status || 400, err.message);
  }

  const result = addCustomModel(provider.id, body.model);
  if (result.error) return sendError(res, result.status, result.error);

  // Custom ids are accepted by /v1 immediately; no restart needed.
  return sendJson(res, 201, providerSnapshot(provider));
}

export async function handleTestModels(req, res, rawId) {
  const provider = resolveProvider(res, rawId);
  if (!provider) return undefined;

  let body;
  try {
    body = await readJson(req, 64 * 1024);
  } catch (err) {
    return sendError(res, err.status || 400, err.message);
  }

  const model = String(body?.model || '').trim();
  const known = new Set(allModels(provider));
  if (!body?.all && !known.has(model)) {
    // Codex custom ids are local dashboard labels, not upstream model ids. Keep
    // them visible, but never send them to ChatGPT as if they were native.
    if (provider.id === 'codex' && customModels(provider.id).includes(model)) {
      return sendJson(res, 200, {
        tested: 1,
        passed: 0,
        failed: 0,
        skipped: 1,
        results: [{
          model,
          ok: false,
          skipped: true,
          status: 422,
          error: 'Custom Codex model ids are local labels and cannot be tested upstream without a native model mapping.',
        }],
      });
    }
    return sendError(res, 400, `Unknown model "${model}" for ${provider.id}.`);
  }
  const models = body?.all ? allModels(provider) : [model];
  const result = await testProviderModels(provider, models, {
    disableOnError: body?.disableOnError === true,
  });
  if (result.error) return sendError(res, result.status || 400, result.error);
  return sendJson(res, 200, result);
}

export async function handleSetModelEnabled(req, res, rawId, rawModel) {
  const provider = resolveProvider(res, rawId);
  if (!provider) return undefined;
  let body;
  try { body = await readJson(req, 16 * 1024); } catch (err) { return sendError(res, err.status || 400, err.message); }
  const model = decodeURIComponent(rawModel);
  if (!catalogModels(provider).includes(model)) return sendError(res, 404, `Unknown model "${model}" for ${provider.id}.`);
  if (typeof body?.enabled !== 'boolean') return sendError(res, 400, 'enabled must be boolean.');
  setModelEnabled(provider.id, model, body.enabled);
  return sendJson(res, 200, providerSnapshot(provider));
}

export function handleRemoveModel(req, res, rawId, rawModel) {
  const provider = resolveProvider(res, rawId);
  if (!provider) return undefined;

  const model = decodeURIComponent(rawModel);
  if (!removeCustomModel(provider.id, model)) {
    return sendError(res, 404, `"${model}" is not a custom model. Catalog models ship with the provider file.`);
  }
  return sendJson(res, 200, providerSnapshot(provider));
}

// Asks the upstream for its catalog. CodeBuddy CN does not document a /models
// route, so a failure is reported as-is instead of being hidden.
async function fetchCatalogForAccount(provider, row, url) {
  const credential = await accessTokenFor(provider, row);
  if (!credential.token) return { accountId: row.id, label: row.label, error: 'No usable account token.' };
  const headers = { accept: 'application/json', ...provider.headers, authorization: `Bearer ${credential.token}` };
  if (provider.id === 'codex') {
    headers['OpenAI-Beta'] = 'codex-1';
    headers.originator = provider.headers?.originator || 'codex_cli_rs';
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const upstream = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    const text = await upstream.text();
    if (!upstream.ok) return { accountId: row.id, label: row.label, status: upstream.status, error: `Provider answered ${upstream.status}.` };
    let payload;
    try { payload = JSON.parse(text); } catch { return { accountId: row.id, label: row.label, error: 'Provider returned invalid JSON.' }; }
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

export async function handleFetchModels(req, res, rawId) {
  const provider = resolveProvider(res, rawId);
  if (!provider) return undefined;
  if (provider.modelDiscovery === false) return sendError(res, 400, `${provider.display.name} uses its bundled model catalog; upstream /models is not available.`);
  const override = provider.baseUrlEnv ? process.env[provider.baseUrlEnv]?.trim() : '';
  const base = provider.modelsPath ? (override || provider.baseUrl).replace(/\/+$/, '') : chatUrl(provider).replace(/\/chat\/completions\/?$/, '').replace(/\/responses\/?$/, '');
  const modelUrl = `${base}${provider.modelsPath || '/models'}`;
  const url = provider.clientVersion ? `${modelUrl}?client_version=${encodeURIComponent(provider.clientVersion)}` : modelUrl;

  if (provider.id === 'codex') {
    const accounts = codexActiveAccounts();
    if (!accounts.length) return sendError(res, 400, 'No account credential for codex. Add an account on the provider page.');
    const results = [];
    const queue = accounts.slice();
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (queue.length) results.push(await fetchCatalogForAccount(provider, queue.shift(), url));
    }));
    const successful = results.filter((result) => Array.isArray(result.models));
    const failed = results.filter((result) => !result.models);
    if (!successful.length) return sendJson(res, 502, { error: { message: failed.map((result) => `${result.label}: ${result.error}`).join(' · '), type: 'upstream_error', url } });
    return sendJson(res, 200, {
      url,
      fetched: [...new Set(successful.flatMap((result) => result.models))].length,
      added: [...new Set(successful.flatMap((result) => result.models))],
      accounts: results.map(({ accountId, label, plan, models, error }) => ({ accountId, label, plan, models: models?.length || 0, error: error || null })),
      partial: failed.length > 0,
      ...providerSnapshot(provider),
    });
  }

  const pooled = await poolToken(provider);
  if (!pooled.token && provider.requiresAccount) return sendError(res, 400, `No account credential for ${provider.id}. Add an account on the provider page.`);
  const headers = { accept: 'application/json', ...provider.headers };
  if (pooled.token) headers.authorization = `Bearer ${pooled.token}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const upstream = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    const text = await upstream.text();
    if (!upstream.ok) return sendJson(res, 502, { error: { message: `Provider answered ${upstream.status} for ${url}. ${text.slice(0, 300)}`.trim(), type: 'upstream_error', url } });
    const payload = JSON.parse(text);
    const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : Array.isArray(payload?.items) ? payload.items : [];
    const ids = list.map((item) => (typeof item === 'string' ? item : item?.id || item?.model || item?.slug)).filter((id) => typeof id === 'string' && id.trim());
    if (!ids.length) return sendJson(res, 502, { error: { message: `Provider returned no models from ${url}.`, type: 'upstream_error', url } });
    const known = new Set(allModels(provider)); const added = [];
    for (const id of ids) { const clean = id.trim(); if (known.has(clean)) continue; const result = addCustomModel(provider.id, clean); if (result.model) { known.add(clean); added.push(clean); } }
    return sendJson(res, 200, { url, fetched: ids.length, added, ...providerSnapshot(provider) });
  } catch (err) { return sendJson(res, 502, { error: { message: err.name === 'AbortError' ? `Provider did not answer ${url} within ${FETCH_TIMEOUT_MS / 1000}s` : `Could not reach ${url}: ${err.message}`, type: 'upstream_error', url } });
  } finally { clearTimeout(timer); }
}
