// Daily token and cost budgets for API keys and providers. Limits live in the
// meta table; counters live in budget_usage with a local day key, so a budget
// resets at the operator's midnight rather than UTC. Cost is an estimate from
// the same price table the Usage page uses: models without a rate still count
// tokens but contribute zero cost, so a cost-only limit cannot see them.
import { getDb } from './db.js';
import { estimateCost, modelPricing } from './pricing.js';
import { notifyWebhook } from './webhook.js';

const CONFIG_KEY = 'budgets';
const ALERTS_KEY = 'budget_alerts';
const PRUNED_KEY = 'budget_pruned';
const RETENTION_DAYS = 90;
const MICRO = 1_000_000;

const DEFAULT_SETTINGS = { enabled: true, keys: {}, providers: {} };

function readMeta(key) {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function writeMeta(key, value) {
  getDb().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

function readJson(key) {
  const raw = readMeta(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Same shape as usage.js localHourKey, day granularity.
export function budgetDay(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function cleanLimit(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const limit = {};
  if (Number.isSafeInteger(raw.tokens) && raw.tokens > 0) limit.tokens = raw.tokens;
  if (typeof raw.cost === 'number' && Number.isFinite(raw.cost) && raw.cost > 0) limit.cost = raw.cost;
  return Object.keys(limit).length ? limit : null;
}

function cleanScopes(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, value] of Object.entries(raw)) {
    if (typeof id !== 'string' || !id) continue;
    const limit = cleanLimit(value);
    if (limit) out[id] = limit;
  }
  return out;
}

export function getBudgetSettings() {
  const raw = readJson(CONFIG_KEY);
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SETTINGS, keys: {}, providers: {} };
  return {
    enabled: raw.enabled !== false,
    keys: cleanScopes(raw.keys),
    providers: cleanScopes(raw.providers),
  };
}

function splitScope(scope) {
  const text = String(scope || '');
  const index = text.indexOf(':');
  if (index < 1) return null;
  return { kind: text.slice(0, index), id: text.slice(index + 1) };
}

function limitFor(settings, kind, id) {
  if (kind === 'key') return settings.keys[id] || null;
  if (kind === 'provider') return settings.providers[id] || null;
  return null;
}

export function validateBudgetPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Body must be a JSON object.';
  const unknown = Object.keys(body).find((key) => !['enabled', 'keys', 'providers'].includes(key));
  if (unknown) return `Unknown field "${unknown}".`;
  if (!('enabled' in body) && !('keys' in body) && !('providers' in body)) return 'Nothing to update.';
  if ('enabled' in body && typeof body.enabled !== 'boolean') return 'enabled must be boolean.';
  for (const field of ['keys', 'providers']) {
    if (body[field] === undefined) continue;
    const scopes = body[field];
    if (!scopes || typeof scopes !== 'object' || Array.isArray(scopes)) return `${field} must be a JSON object.`;
    for (const [id, value] of Object.entries(scopes)) {
      if (!id.trim()) return `Every ${field} entry needs an id.`;
      if (value === null) continue;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return `${field}.${id} must be an object or null.`;
      const unknownField = Object.keys(value).find((key) => !['tokens', 'cost'].includes(key));
      if (unknownField) return `Unknown limit field "${unknownField}" for ${field}.${id}.`;
      if (value.tokens !== undefined && value.tokens !== null) {
        if (!Number.isSafeInteger(value.tokens) || value.tokens <= 0) return `${field}.${id}.tokens must be a positive integer.`;
      }
      if (value.cost !== undefined && value.cost !== null) {
        if (typeof value.cost !== 'number' || !Number.isFinite(value.cost) || value.cost <= 0) return `${field}.${id}.cost must be a positive number in USD.`;
      }
      if (value.tokens == null && value.cost == null) return `${field}.${id} needs at least one of tokens or cost.`;
    }
  }
  return null;
}

function mergeScopes(current, patch) {
  if (patch === undefined) return current;
  const next = { ...current };
  for (const [id, value] of Object.entries(patch)) {
    if (value === null) {
      delete next[id];
      continue;
    }
    const limit = {};
    if (value.tokens != null) limit.tokens = value.tokens;
    if (value.cost != null) limit.cost = value.cost;
    next[id] = limit;
  }
  return next;
}

export function updateBudgetSettings(patch = {}) {
  const current = getBudgetSettings();
  const next = {
    enabled: patch.enabled === undefined ? current.enabled : patch.enabled,
    keys: mergeScopes(current.keys, patch.keys),
    providers: mergeScopes(current.providers, patch.providers),
  };
  writeMeta(CONFIG_KEY, JSON.stringify(next));
  return { settings: next };
}

function readUsage(day, scope) {
  const row = getDb().prepare('SELECT requests, tokens_in, tokens_out, cost_micro FROM budget_usage WHERE day = ? AND scope = ?')
    .get(day, scope);
  const tokensIn = row?.tokens_in || 0;
  const tokensOut = row?.tokens_out || 0;
  const costMicro = row?.cost_micro || 0;
  return {
    requests: row?.requests || 0,
    tokensIn,
    tokensOut,
    tokens: tokensIn + tokensOut,
    costMicro,
    cost: costMicro / MICRO,
  };
}

export function budgetUsage(day = budgetDay()) {
  const rows = getDb().prepare('SELECT scope, requests, tokens_in, tokens_out, cost_micro FROM budget_usage WHERE day = ?')
    .all(day);
  return rows.map((row) => {
    const tokensIn = row.tokens_in || 0;
    const tokensOut = row.tokens_out || 0;
    const costMicro = row.cost_micro || 0;
    return {
      scope: row.scope,
      requests: row.requests || 0,
      tokensIn,
      tokensOut,
      tokens: tokensIn + tokensOut,
      costMicro,
      cost: costMicro / MICRO,
    };
  });
}

// Configured limit plus today's counters for one scope, or null when the scope
// has no limit or budgets are switched off.
export function budgetFor(scope) {
  const parsed = splitScope(scope);
  if (!parsed) return null;
  const settings = getBudgetSettings();
  if (!settings.enabled) return null;
  const limit = limitFor(settings, parsed.kind, parsed.id);
  if (!limit) return null;
  const day = budgetDay();
  return { scope, kind: parsed.kind, id: parsed.id, day, limit, used: readUsage(day, scope) };
}

function markAlert(day, scope) {
  const raw = readJson(ALERTS_KEY);
  const alerts = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const today = alerts[day] && typeof alerts[day] === 'object' ? alerts[day] : {};
  if (today[scope]) return false;
  today[scope] = true;
  // Only today matters: the marker exists to keep one alert per scope per day.
  writeMeta(ALERTS_KEY, JSON.stringify({ [day]: today }));
  return true;
}

function alertBudget(budget, reasons) {
  const day = budget.day || budgetDay();
  if (!markAlert(day, budget.scope)) return;
  void notifyWebhook('budget', {
    scope: budget.scope,
    kind: budget.kind,
    id: budget.id,
    day,
    reasons,
    limit: budget.limit,
    used: {
      requests: budget.used.requests,
      tokens: budget.used.tokens,
      tokensIn: budget.used.tokensIn,
      tokensOut: budget.used.tokensOut,
      cost: Number(budget.used.cost.toFixed(6)),
    },
  });
}

// Returns a verdict when this request must be refused, otherwise null.
export function budgetGate(scope) {
  const budget = budgetFor(scope);
  if (!budget) return null;
  const reasons = [];
  if (budget.limit.tokens != null && budget.used.tokens >= budget.limit.tokens) reasons.push('tokens');
  if (budget.limit.cost != null && budget.used.cost >= budget.limit.cost) reasons.push('cost');
  if (!reasons.length) return null;
  alertBudget(budget, reasons);
  return { ...budget, reasons };
}

function pruneOld(db) {
  const day = budgetDay();
  if (readMeta(PRUNED_KEY) === day) return;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  db.prepare('DELETE FROM budget_usage WHERE day < ?').run(budgetDay(cutoff));
  writeMeta(PRUNED_KEY, day);
}

// Called once per successful request. Only scopes with a configured limit are
// written, which keeps the table small and the hot path to one upsert per scope.
export function recordBudgetUsage({ keyId = null, provider = null, model = '', usage = null } = {}) {
  const settings = getBudgetSettings();
  const scopes = [];
  if (keyId && settings.keys[keyId]) scopes.push(`key:${keyId}`);
  if (provider && settings.providers[provider]) scopes.push(`provider:${provider}`);
  if (!scopes.length) return;

  const tokensIn = Math.max(0, Number(usage?.prompt_tokens) || 0);
  const tokensOut = Math.max(0, Number(usage?.completion_tokens) || 0);
  const cost = estimateCost(tokensIn, tokensOut, modelPricing(model));
  const costMicro = cost == null ? 0 : Math.max(0, Math.round(cost * MICRO));
  const day = budgetDay();
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO budget_usage (day, scope, requests, tokens_in, tokens_out, cost_micro)
    VALUES (?, ?, 1, ?, ?, ?)
    ON CONFLICT(day, scope) DO UPDATE SET
      requests = requests + 1,
      tokens_in = tokens_in + excluded.tokens_in,
      tokens_out = tokens_out + excluded.tokens_out,
      cost_micro = cost_micro + excluded.cost_micro
  `);
  for (const scope of scopes) upsert.run(day, scope, tokensIn, tokensOut, costMicro);
  pruneOld(db);

  // A request can finish exactly on the limit; tell the webhook once, even if
  // the next request never arrives to hit the gate.
  for (const scope of scopes) {
    const budget = budgetFor(scope);
    if (!budget) continue;
    const reasons = [];
    if (budget.limit.tokens != null && budget.used.tokens >= budget.limit.tokens) reasons.push('tokens');
    if (budget.limit.cost != null && budget.used.cost >= budget.limit.cost) reasons.push('cost');
    if (reasons.length) alertBudget(budget, reasons);
  }
}
