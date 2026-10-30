import { randomUUID } from 'node:crypto';

import { ACCOUNT_STRATEGIES, normalizeStrategy } from './accounts.js';
import { getDb, transaction } from './db.js';

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,119}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const CREDENTIAL_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie',
  'x-api-key', 'api-key', 'x-auth-token', 'x-access-token',
]);
const EDITABLE_FIELDS = new Set(['id', 'prefix', 'name', 'website', 'baseUrl', 'chatPath', 'headers', 'models', 'format', 'forceStream', 'requiresAccount', 'baseUrlEnv', 'refresh', 'quota', 'checkin', 'reasoning', 'accountStrategy']);

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value || '');
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function rowToEntry(row) {
  const legacyAliases = parseJson(row.aliases, []);
  const headers = parseJson(row.headers, {});
  const models = parseJson(row.models, []);
  const config = parseJson(row.config, {});
  return {
    ...config,
    sourceId: row.source_id || row.id,
    id: row.id,
    prefix: row.prefix || (Array.isArray(legacyAliases) && legacyAliases[0]) || row.id,
    name: row.name,
    website: row.website,
    baseUrl: row.base_url,
    chatPath: row.chat_path,
    headers: headers && !Array.isArray(headers) ? headers : {},
    models: Array.isArray(models) ? models : [],
  };
}

export function savedProviders() {
  return getDb()
    .prepare('SELECT * FROM custom_providers ORDER BY created_at, rowid')
    .all()
    .map(rowToEntry);
}

export function savedOverrides() {
  return getDb()
    .prepare('SELECT * FROM provider_overrides ORDER BY updated_at, rowid')
    .all()
    .map(rowToEntry);
}

function slug(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function providerIdFor(input = {}) {
  return slug(input.id || input.name);
}

function has(input, key) {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function validUrl(value, label, required = false) {
  const text = String(value || '').trim();
  if (!text && !required) return { value: '' };
  if (text.length > 300) return { error: `${label} is too long.` };
  try {
    const url = new URL(text);
    if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password || url.hash) {
      throw new Error('invalid');
    }
    return { value: url.toString().replace(/\/$/, '') };
  } catch {
    return { error: `${label} must be an http:// or https:// URL without credentials or a fragment.` };
  }
}

function aliasesFor(raw, id) {
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === 'string' ? raw.split(/[\s,]+/) : null;
  if (!values) return { error: 'Aliases must be an array or comma-separated string.' };
  const aliases = [...new Set(values.map((alias) => String(alias).trim()).filter(Boolean))];
  if (!aliases.length || aliases.length > 20) return { error: 'Provide 1-20 aliases.' };
  const bad = aliases.find((alias) => !ID.test(alias));
  if (bad) return { error: `"${bad}" is not a valid alias.` };
  return { aliases };
}

function modelsFor(raw) {
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === 'string' ? raw.split(/[\s,]+/) : null;
  if (!values) return { error: 'Models must be an array or comma-separated string.' };
  const models = [...new Set(values.map((model) => String(model).trim()).filter(Boolean))];
  if (!models.length || models.length > 500) return { error: 'Provide 1-500 model ids.' };
  const bad = models.find((model) => !MODEL_ID.test(model));
  if (bad) return { error: `"${bad}" is not a valid model id.` };
  return { models };
}

function headersFor(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'Headers must be an object of static header names and values.' };
  }
  const entries = Object.entries(raw);
  if (entries.length > 30) return { error: 'Provide at most 30 headers.' };
  const headers = {};
  const names = new Set();
  for (const [name, rawValue] of entries) {
    const lower = name.toLowerCase();
    const value = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (!HEADER_NAME.test(name) || names.has(lower)) return { error: `"${name}" is not a valid unique header name.` };
    if (CREDENTIAL_HEADERS.has(lower) || /(?:^|[-_])(api[-_]?key|token|secret|credential)(?:$|[-_])/i.test(lower)) {
      return { error: `"${name}" is a credential header. Store credentials in the account pool instead.` };
    }
    if (!value || value.length > 1024 || /[\r\n\0]/.test(value)) return { error: `"${name}" has an invalid header value.` };
    names.add(lower);
    headers[name] = value;
  }
  return { headers };
}

function optionalEndpoint(raw, label) {
  if (raw == null) return { value: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `${label} must be an object or null.` };
  const url = validUrl(raw.url, `${label} URL`);
  if (url.error) return { error: url.error };
  if (!url.value) return { value: null };
  const headers = headersFor(raw.headers || {});
  if (headers.error) return { error: headers.error };
  return { value: { ...raw, url: url.value, headers: headers.headers } };
}

function baseEntry(provider) {
  return {
    sourceId: provider.sourceId || provider.id,
    id: provider.id,
    prefix: provider.prefix || provider.id,
    name: provider.display.name,
    website: provider.display.website || '',
    baseUrl: provider.baseUrl,
    chatPath: provider.chatPath,
    headers: { ...provider.headers },
    models: [...provider.models],
    format: provider.format,
    forceStream: Boolean(provider.forceStream),
    requiresAccount: Boolean(provider.requiresAccount),
    baseUrlEnv: provider.baseUrlEnv || '',
    refresh: provider.refresh || null,
    quota: provider.quota || null,
    checkin: provider.checkin || null,
    reasoning: provider.reasoning || null,
    accountStrategy: normalizeStrategy(provider.accountStrategy),
  };
}

// Validates the complete persisted shape. PATCH values merge with the active
// provider first, so omitted fields retain their existing configuration.
export function prepareProviderConfig(provider, patch = {}, { creating = false } = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { status: 400, error: 'Provider configuration must be a JSON object.' };
  }
  const unknown = Object.keys(patch).find((key) => !EDITABLE_FIELDS.has(key) && key !== 'tokenEnv');
  if (unknown) return { status: 400, error: `Unknown provider field "${unknown}".` };
  if (has(patch, 'tokenEnv') && String(patch.tokenEnv || '').trim()) {
    return { status: 400, error: 'Provider credentials must be added through the account pool.' };
  }

  const base = provider ? baseEntry(provider) : {
    sourceId: randomUUID(),
    id: providerIdFor(patch),
    prefix: providerIdFor(patch),
    name: '',
    website: '',
    baseUrl: '',
    chatPath: '/chat/completions',
    headers: {},
    models: [],
    format: 'openai',
    forceStream: false,
    requiresAccount: false,
    baseUrlEnv: '',
    refresh: null,
    quota: null,
    checkin: null,
  };
  const id = creating ? providerIdFor(patch) : has(patch, 'id') ? String(patch.id).trim() : base.id;
  if (!ID.test(id)) return { status: 400, error: 'Provider id must be lowercase letters, digits and dashes.' };

  const name = has(patch, 'name') ? String(patch.name || '').trim() : base.name;
  if (name.length < 2 || name.length > 60) return { status: 400, error: 'Provider name must be 2-60 characters.' };

  const baseUrl = validUrl(has(patch, 'baseUrl') ? patch.baseUrl : base.baseUrl, 'Base URL', true);
  if (baseUrl.error) return { status: 400, error: baseUrl.error };
  let chatPath = has(patch, 'chatPath') ? String(patch.chatPath || '').trim() : base.chatPath;
  if (!chatPath.startsWith('/')) chatPath = `/${chatPath}`;
  if (chatPath.length > 120 || /[\s?#\r\n]/.test(chatPath)) return { status: 400, error: 'Chat path must be a URL path up to 120 characters.' };

  const website = validUrl(has(patch, 'website') ? patch.website : base.website, 'Website');
  if (website.error) return { status: 400, error: website.error };
  const prefix = has(patch, 'prefix') ? String(patch.prefix || '') : base.prefix;
  if (!ID.test(prefix) || /[\s,]/.test(prefix)) {
    return { status: 400, error: 'Prefix must be one lowercase token with letters, digits, or dashes only.' };
  }
  const models = modelsFor(has(patch, 'models') ? patch.models : base.models);
  if (models.error) return { status: 400, error: models.error };
  const headers = headersFor(has(patch, 'headers') ? patch.headers : base.headers);
  if (headers.error) return { status: 400, error: headers.error };
  const format = has(patch, 'format') ? String(patch.format || '').trim() : base.format;
  if (!['openai'].includes(format)) return { status: 400, error: 'Only the openai format is supported.' };
  const baseUrlEnv = has(patch, 'baseUrlEnv') ? String(patch.baseUrlEnv || '').trim() : base.baseUrlEnv;
  if (baseUrlEnv && !/^[A-Z][A-Z0-9_]{0,79}$/.test(baseUrlEnv)) return { status: 400, error: 'Base URL environment variable name is invalid.' };
  const refresh = optionalEndpoint(has(patch, 'refresh') ? patch.refresh : base.refresh, 'Refresh endpoint');
  const quota = optionalEndpoint(has(patch, 'quota') ? patch.quota : base.quota, 'Quota endpoint');
  const checkin = optionalEndpoint(has(patch, 'checkin') ? patch.checkin : base.checkin, 'Check-in endpoint');
  const reasoning = has(patch, 'reasoning') ? patch.reasoning : base.reasoning;
  if (reasoning != null && (typeof reasoning !== 'object' || Array.isArray(reasoning))) return { status: 400, error: 'Reasoning configuration must be an object or null.' };
  const rawStrategy = has(patch, 'accountStrategy')
    ? String(patch.accountStrategy || '').trim()
    : base.accountStrategy;
  if (has(patch, 'accountStrategy') && !ACCOUNT_STRATEGIES.includes(rawStrategy)) {
    return { status: 400, error: `accountStrategy must be one of: ${ACCOUNT_STRATEGIES.join(', ')}.` };
  }
  const accountStrategy = normalizeStrategy(rawStrategy);
  for (const value of [refresh, quota, checkin]) if (value.error) return { status: 400, error: value.error };

  return {
    entry: {
      sourceId: base.sourceId,
      id,
      prefix,
      name,
      website: website.value,
      baseUrl: baseUrl.value,
      chatPath,
      headers: headers.headers,
      models: models.models,
      format,
      forceStream: has(patch, 'forceStream') ? patch.forceStream === true : base.forceStream,
      requiresAccount: has(patch, 'requiresAccount') ? patch.requiresAccount === true : base.requiresAccount,
      baseUrlEnv,
      refresh: refresh.value,
      quota: quota.value,
      checkin: checkin.value,
      reasoning: reasoning || null,
      accountStrategy,
    },
  };
}

// Turns a stored entry into the same shape the shipped provider files export.
export function toProvider(entry) {
  return {
    sourceId: entry.sourceId,
    id: entry.id,
    prefix: entry.prefix || entry.id,
    display: { name: entry.name, website: entry.website || '' },
    baseUrl: entry.baseUrl,
    chatPath: entry.chatPath || '/chat/completions',
    format: entry.format || 'openai',
    forceStream: Boolean(entry.forceStream),
    headers: { ...entry.headers },
    tokenEnv: [],
    requiresAccount: Boolean(entry.requiresAccount),
    baseUrlEnv: entry.baseUrlEnv || '',
    refresh: entry.refresh || undefined,
    quota: entry.quota || undefined,
    checkin: entry.checkin || undefined,
    models: [...entry.models],
    accountStrategy: normalizeStrategy(entry.accountStrategy),
    custom: true,
  };
}

function advancedConfig(entry) {
  return {
    format: entry.format,
    forceStream: Boolean(entry.forceStream),
    requiresAccount: Boolean(entry.requiresAccount),
    baseUrlEnv: entry.baseUrlEnv || '',
    refresh: entry.refresh || null,
    quota: entry.quota || null,
    checkin: entry.checkin || null,
    reasoning: entry.reasoning || null,
    accountStrategy: normalizeStrategy(entry.accountStrategy),
  };
}

export function createCustomProvider(input = {}) {
  const prepared = prepareProviderConfig(null, input, { creating: true });
  if (prepared.error) return prepared;
  const { entry } = prepared;
  const db = getDb();
  if (db.prepare('SELECT 1 AS hit FROM custom_providers WHERE id = ?').get(entry.id)) {
    return { status: 409, error: `A custom provider with id "${entry.id}" already exists.` };
  }
  db.prepare(`
    INSERT INTO custom_providers
      (id, source_id, name, website, base_url, chat_path, token_env, prefix, aliases, headers, models, config, created_at)
    VALUES (?, ?, ?, ?, ?, ?, '', ?, '[]', ?, ?, ?, ?)
  `).run(entry.id, entry.sourceId, entry.name, entry.website, entry.baseUrl, entry.chatPath, entry.prefix,
    JSON.stringify(entry.headers), JSON.stringify(entry.models), JSON.stringify(advancedConfig(entry)), Date.now());
  return { entry };
}

export function saveProviderConfig(provider, entry) {
  const originalId = provider.id;
  transaction((db) => {
    if (entry.id !== originalId) {
      db.prepare('UPDATE accounts SET provider = ? WHERE provider = ?').run(entry.id, originalId);
      db.prepare('UPDATE custom_models SET provider = ? WHERE provider = ?').run(entry.id, originalId);
    }
    if (provider.custom) {
      db.prepare(`
        UPDATE custom_providers
           SET id = ?, prefix = ?, name = ?, website = ?, base_url = ?, chat_path = ?,
               aliases = '[]', headers = ?, models = ?, config = ?
         WHERE source_id = ?
      `).run(entry.id, entry.prefix, entry.name, entry.website, entry.baseUrl, entry.chatPath,
        JSON.stringify(entry.headers), JSON.stringify(entry.models), JSON.stringify(advancedConfig(entry)), entry.sourceId);
      db.prepare('DELETE FROM provider_overrides WHERE source_id = ?').run(entry.sourceId);
    } else {
      db.prepare(`
        INSERT INTO provider_overrides
          (source_id, id, prefix, aliases, name, website, base_url, chat_path, headers, models, config, updated_at)
        VALUES (?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id) DO UPDATE SET
          id = excluded.id, prefix = excluded.prefix, aliases = '[]', name = excluded.name,
          website = excluded.website, base_url = excluded.base_url,
          chat_path = excluded.chat_path, headers = excluded.headers,
          models = excluded.models, config = excluded.config, updated_at = excluded.updated_at
      `).run(entry.sourceId, entry.id, entry.prefix, entry.name, entry.website,
        entry.baseUrl, entry.chatPath, JSON.stringify(entry.headers), JSON.stringify(entry.models), JSON.stringify(advancedConfig(entry)), Date.now());
    }
  });
}

export function deleteCustomProvider(id) {
  return transaction((db) => {
    const row = db.prepare('SELECT source_id FROM custom_providers WHERE id = ?').get(id);
    if (!row) return false;
    db.prepare('DELETE FROM custom_models WHERE provider = ?').run(id);
    db.prepare('DELETE FROM accounts WHERE provider = ?').run(id);
    const result = db.prepare('DELETE FROM custom_providers WHERE source_id = ?').run(row.source_id);
    return Number(result.changes) > 0;
  });
}
