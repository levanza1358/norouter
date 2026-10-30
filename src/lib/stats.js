import { config } from '../config.js';
import { getRequireApiKey } from './api-keys.js';
import { accountCounts, providerQuotaSummary } from './accounts.js';
import { hasQuotaEndpoint } from './codebuddy.js';
import { allModels, providers } from '../providers/index.js';

const started = Date.now();
const HISTORY_SIZE = 40;
// Kept deeper than any screen shows so tall monitors can fill the log card.
const EVENT_SIZE = 60;
const RECENT_SIZE = 40;

export const stats = {
  started,
  requests: 0,
  errors: 0,
  upstreamErrors: 0,
  tokensIn: 0,
  tokensOut: 0,
  lastError: null,
  lastLatency: null,
  perModel: new Map(),
  // Per-provider totals, so the provider page can report its own usage without
  // re-scanning every model.
  perProvider: new Map(),
  // Ring buffer for the sparkline: one slot per recorded request.
  history: [],
  events: [],
  recent: [],
};

// Requests that have reached the upstream but not finished yet. The Usage page
// merges these into the activity feed as live "streaming" rows, so a request is
// visible the moment the first byte is due, not only after the response closes.
let activeRequestId = 0;
const activeRequests = new Map();

function bucket(model) {
  if (!stats.perModel.has(model)) {
    stats.perModel.set(model, { requests: 0, tokensIn: 0, tokensOut: 0, lastMs: null });
  }
  return stats.perModel.get(model);
}

function providerBucket(id) {
  if (!id) return null;
  if (!stats.perProvider.has(id)) {
    stats.perProvider.set(id, {
      requests: 0,
      errors: 0,
      tokensIn: 0,
      tokensOut: 0,
      lastMs: null,
      lastError: null,
    });
  }
  return stats.perProvider.get(id);
}

export function providerUsage(id) {
  const entry = stats.perProvider.get(id);
  return entry
    ? { ...entry }
    : { requests: 0, errors: 0, tokensIn: 0, tokensOut: 0, lastMs: null, lastError: null };
}

function pushHistory(entry) {
  stats.history.push(entry);
  if (stats.history.length > HISTORY_SIZE) stats.history.shift();
}

function pushEvent(type, message) {
  stats.events.unshift({ at: new Date().toISOString(), type, message });
  if (stats.events.length > EVENT_SIZE) stats.events.pop();
}

function pushRecent(entry) {
  stats.recent.unshift(entry);
  if (stats.recent.length > RECENT_SIZE) stats.recent.pop();
}

export function recordRequest({ provider, model, usage, ms }) {
  stats.requests += 1;
  const entry = bucket(model);
  entry.requests += 1;
  const inTokens = usage?.prompt_tokens || 0;
  const outTokens = usage?.completion_tokens || 0;
  const latency = ms == null ? null : Math.round(ms);
  if (latency != null) {
    entry.lastMs = latency;
    stats.lastLatency = latency;
  }
  stats.tokensIn += inTokens;
  stats.tokensOut += outTokens;
  entry.tokensIn += inTokens;
  entry.tokensOut += outTokens;

  const owner = providerBucket(provider);
  if (owner) {
    owner.requests += 1;
    owner.tokensIn += inTokens;
    owner.tokensOut += outTokens;
    if (latency != null) owner.lastMs = latency;
  }

  const tokens = inTokens + outTokens;
  pushHistory({ ms: latency || 0, tokens, ok: true });
  pushEvent('request', `${model} · ${tokens} tok · ${latency ?? '?'} ms`);
  pushRecent({ at: new Date().toISOString(), model, tokensIn: inTokens, tokensOut: outTokens, ms: latency, ok: true });
}

export function recordError(message, { upstream = false, model = null, provider = null } = {}) {
  stats.errors += 1;
  if (upstream) stats.upstreamErrors += 1;
  stats.lastError = { message, at: new Date().toISOString() };
  const owner = providerBucket(provider);
  if (owner) {
    owner.errors += 1;
    owner.lastError = { message, at: new Date().toISOString() };
  }
  pushHistory({ ms: 0, tokens: 0, ok: false });
  pushEvent('error', message);
  pushRecent({ at: new Date().toISOString(), model, tokensIn: 0, tokensOut: 0, ms: null, ok: false, error: message });
}

export function recordEvent(type, message) {
  pushEvent(type, message);
}

export function beginActiveRequest({ provider = '', model = '', account = '' }) {
  const id = ++activeRequestId;
  const entry = {
    id,
    at: Date.now(),
    provider,
    model,
    account,
    ms: null,
    tokensIn: 0,
    tokensOut: 0,
  };
  activeRequests.set(id, entry);
  return id;
}

export function updateActiveRequest(id, patch = {}) {
  const entry = activeRequests.get(id);
  if (!entry) return;
  if (patch.tokensIn != null) entry.tokensIn = patch.tokensIn;
  if (patch.tokensOut != null) entry.tokensOut = patch.tokensOut;
  if (patch.ms != null) entry.ms = patch.ms;
  if (patch.provider != null) entry.provider = patch.provider;
  if (patch.model != null) entry.model = patch.model;
  if (patch.account != null) entry.account = patch.account;
}

export function endActiveRequest(id) {
  activeRequests.delete(id);
}

export function activeRequestSnapshot() {
  const now = Date.now();
  return [...activeRequests.values()].map((entry) => ({
    ...entry,
    ms: now - entry.at,
  }));
}

export function statusSnapshot() {
  const models = [...stats.perModel.entries()]
    .map(([model, value]) => ({ model, ...value }))
    .sort((a, b) => b.requests - a.requests);

  return {
    uptimeSeconds: Math.round((Date.now() - stats.started) / 1000),
    requests: stats.requests,
    errors: stats.errors,
    upstreamErrors: stats.upstreamErrors,
    tokensIn: stats.tokensIn,
    tokensOut: stats.tokensOut,
    lastError: stats.lastError,
    lastLatency: stats.lastLatency,
    requireApiKey: getRequireApiKey(config.requireApiKey),
    successRate:
      stats.requests === 0
        ? null
        : Math.round(((stats.requests - stats.errors) / stats.requests) * 1000) / 10,
    providers: providers.map((provider) => {
      const pool = accountCounts(provider.id);
      const credential = provider.requiresAccount
        ? pool.total > 0 ? 'pool' : 'missing'
        : 'open';
      return {
        id: provider.id,
        prefix: provider.prefix || provider.id,
        name: provider.display.name,
        website: provider.display.website,
        format: provider.format,
        credential,
        accounts: pool.total,
        activeAccounts: pool.active,
        models: allModels(provider).length,
        modelIds: allModels(provider),
        tokenEnv: provider.tokenEnv,
        baseUrl: provider.baseUrl,
        quotaSupported: Boolean(provider.quota?.url) || hasQuotaEndpoint(provider),
        quota: providerQuotaSummary(provider.id),
      };
    }),
    models,
    history: stats.history,
    events: stats.events,
    recent: stats.recent,
    active: activeRequestSnapshot(),
  };
}
