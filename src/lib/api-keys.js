import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { getDb } from './db.js';

const KEY_PREFIX = 'nr_live_';
const NAME_MAX = 80;
const SECRET_MAX = 160;
const SETTING = 'require_api_key';

function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function dayOf(time = Date.now()) { return new Date(time).toISOString().slice(0, 10); }
function numberOrNull(value, name) {
  if (value === undefined || value === null || value === '') return { value: null };
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) return { error: `${name} must be a non-negative integer.` };
  return { value: number };
}

function tokenLimitOrNull(value) {
  if (value === undefined || value === null || value === '') return { value: null };
  const text = String(value).trim().replace(/\s+/g, '').toUpperCase();
  const match = text.match(/^(\d+(?:\.\d+)?)([KMBT])?$/);
  if (!match) return { error: 'tokenLimit must be a non-negative integer or use K, M, B, or T (for example 1M).' };
  const multiplier = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[match[2] || ''] || 1;
  const number = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(number) || number < 0) return { error: 'tokenLimit is too large.' };
  return { value: number };
}

function publicKey(row, usage = {}) {
  const expired = row.expires_at != null && row.expires_at <= Date.now();
  const requests = Number(usage.requests || 0);
  const tokens = Number(usage.tokens_in || 0) + Number(usage.tokens_out || 0);
  const limited = (row.request_limit != null && requests >= row.request_limit) || (row.token_limit != null && tokens >= row.token_limit);
  return {
    id: row.id, name: row.name,
    secret: row.secret || null,
    masked: `${row.key_prefix}••••••••${row.key_hash.slice(-4)}`,
    enabled: Boolean(row.enabled), status: !row.enabled ? 'disabled' : expired ? 'expired' : limited ? 'limit' : 'enabled',
    createdAt: row.created_at, lastUsedAt: row.last_used_at, expiresAt: row.expires_at,
    requestLimit: row.request_limit, tokenLimit: row.token_limit, requests, tokens,
  };
}

function rowsWithUsage() {
  return getDb().prepare(`SELECT k.*, COALESCE(SUM(u.requests), 0) AS usage_requests,
    COALESCE(SUM(u.tokens_in), 0) AS usage_tokens_in, COALESCE(SUM(u.tokens_out), 0) AS usage_tokens_out
    FROM api_keys k LEFT JOIN api_key_usage u ON u.key_id = k.id GROUP BY k.id ORDER BY k.created_at DESC`).all();
}

export function listApiKeys() {
  return rowsWithUsage().map((row) => publicKey(row, { requests: row.usage_requests, tokens_in: row.usage_tokens_in, tokens_out: row.usage_tokens_out }));
}

export function createApiKey(input = {}) {
  const name = String(input.name || '').trim();
  if (!name || name.length > NAME_MAX) return { error: `Key name must be 1-${NAME_MAX} characters.`, status: 400 };
  const custom = String(input.secret || '').trim();
  if (custom && (custom.length > SECRET_MAX || !/^[A-Za-z0-9._-]+$/.test(custom))) return { error: 'Custom secret contains invalid characters or is too long.', status: 400 };
  const secret = custom || `${KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
  const expiresAt = input.expiresAt ? Date.parse(input.expiresAt) : null;
  if (input.expiresAt && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) return { error: 'expiresAt must be a future date.', status: 400 };
  const requestLimit = numberOrNull(input.requestLimit, 'requestLimit');
  const tokenLimit = tokenLimitOrNull(input.tokenLimit);
  if (requestLimit.error) return { error: requestLimit.error, status: 400 };
  if (tokenLimit.error) return { error: tokenLimit.error, status: 400 };
  const row = { id: randomUUID(), name, secret, keyHash: hash(secret), keyPrefix: secret.slice(0, Math.min(secret.length, KEY_PREFIX.length + 4)), createdAt: Date.now(), expiresAt, requestLimit: requestLimit.value, tokenLimit: tokenLimit.value };
  try {
    getDb().prepare(`INSERT INTO api_keys (id, name, secret, key_hash, key_prefix, enabled, created_at, expires_at, request_limit, token_limit)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`).run(row.id, row.name, row.secret, row.keyHash, row.keyPrefix, row.createdAt, row.expiresAt, row.requestLimit, row.tokenLimit);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.errcode === 2067) return { error: 'That API secret already exists.', status: 409 };
    throw err;
  }
  return { key: publicKey({ id: row.id, name: row.name, secret: row.secret, key_hash: row.keyHash, key_prefix: row.keyPrefix, enabled: 1, created_at: row.createdAt, last_used_at: null, expires_at: row.expiresAt, request_limit: row.requestLimit, token_limit: row.tokenLimit }), secret };
}

export function updateApiKey(id, input = {}) {
  const current = getDb().prepare('SELECT * FROM api_keys WHERE id = ?').get(id);
  if (!current) return null;
  const name = input.name === undefined ? current.name : String(input.name).trim();
  if (!name || name.length > NAME_MAX) return { error: `Key name must be 1-${NAME_MAX} characters.`, status: 400 };
  const requestLimit = numberOrNull(input.requestLimit === undefined ? current.request_limit : input.requestLimit, 'requestLimit');
  const tokenLimit = tokenLimitOrNull(input.tokenLimit === undefined ? current.token_limit : input.tokenLimit);
  if (requestLimit.error) return { error: requestLimit.error, status: 400 };
  if (tokenLimit.error) return { error: tokenLimit.error, status: 400 };
  const hasSecret = input.secret !== undefined;
  const secret = hasSecret ? String(input.secret).trim() : current.secret;
  if (hasSecret && (!secret || secret.length > SECRET_MAX || !/^[A-Za-z0-9._-]+$/.test(secret))) return { error: 'Secret contains invalid characters or is too long.', status: 400 };
  let expiresAt = current.expires_at;
  if (input.expiresAt !== undefined) { expiresAt = input.expiresAt ? Date.parse(input.expiresAt) : null; if (input.expiresAt && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) return { error: 'expiresAt must be a future date.', status: 400 }; }
  const enabled = input.enabled === undefined ? current.enabled : input.enabled ? 1 : 0;
  try {
    const statement = hasSecret
      ? 'UPDATE api_keys SET name = ?, secret = ?, key_hash = ?, key_prefix = ?, enabled = ?, expires_at = ?, request_limit = ?, token_limit = ? WHERE id = ?'
      : 'UPDATE api_keys SET name = ?, enabled = ?, expires_at = ?, request_limit = ?, token_limit = ? WHERE id = ?';
    const values = hasSecret
      ? [name, secret, hash(secret), secret.slice(0, Math.min(secret.length, KEY_PREFIX.length + 4)), enabled, expiresAt, requestLimit.value, tokenLimit.value, id]
      : [name, enabled, expiresAt, requestLimit.value, tokenLimit.value, id];
    getDb().prepare(statement).run(...values);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.errcode === 2067) return { error: 'That API secret already exists.', status: 409 };
    throw err;
  }
  return listApiKeys().find((key) => key.id === id);
}

export function rotateApiKey(id, input = {}) {
  const current = getDb().prepare('SELECT * FROM api_keys WHERE id = ?').get(id);
  if (!current) return null;
  const custom = String(input.secret || '').trim();
  if (custom && (custom.length > SECRET_MAX || !/^[A-Za-z0-9._-]+$/.test(custom))) return { error: 'Custom secret contains invalid characters or is too long.', status: 400 };
  const secret = custom || `${KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
  const keyHash = hash(secret);
  const keyPrefix = secret.slice(0, Math.min(secret.length, KEY_PREFIX.length + 4));
  try {
    getDb().prepare('UPDATE api_keys SET secret = ?, key_hash = ?, key_prefix = ? WHERE id = ?').run(secret, keyHash, keyPrefix, id);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.errcode === 2067) return { error: 'That API secret already exists.', status: 409 };
    throw err;
  }
  return { key: listApiKeys().find((key) => key.id === id), secret };
}

export function revokeApiKey(id) {
  const db = getDb(); db.prepare('DELETE FROM api_key_usage WHERE key_id = ?').run(id);
  return Boolean(db.prepare('DELETE FROM api_keys WHERE id = ?').run(id).changes);
}

export function authorizeManagedKey(secret, { consume = true } = {}) {
  if (!secret) return null;
  const row = getDb().prepare('SELECT * FROM api_keys WHERE (secret = ? OR key_hash = ?) AND enabled = 1').get(secret, hash(secret));
  if (!row || (row.expires_at != null && row.expires_at <= Date.now())) return null;
  const usage = getDb().prepare('SELECT COALESCE(SUM(requests), 0) AS requests, COALESCE(SUM(tokens_in), 0) AS tokens_in, COALESCE(SUM(tokens_out), 0) AS tokens_out FROM api_key_usage WHERE key_id = ?').get(row.id);
  if ((row.request_limit != null && usage.requests >= row.request_limit) || (row.token_limit != null && usage.tokens_in + usage.tokens_out >= row.token_limit)) return null;
  if (consume) getDb().prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(Date.now(), row.id);
  return { managedId: row.id };
}

export function recordApiKeyRequest(id) { if (id) getDb().prepare(`INSERT INTO api_key_usage (key_id, day, requests) VALUES (?, ?, 1) ON CONFLICT(key_id, day) DO UPDATE SET requests = requests + 1`).run(id, dayOf()); }
export function recordApiKeyTokens(id, usage) { if (id) getDb().prepare(`INSERT INTO api_key_usage (key_id, day, tokens_in, tokens_out) VALUES (?, ?, ?, ?) ON CONFLICT(key_id, day) DO UPDATE SET tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out`).run(id, dayOf(), usage?.prompt_tokens || 0, usage?.completion_tokens || 0); }
export function apiKeyUsage(id, days = 30) { const safeDays = Math.min(366, Math.max(1, Number(days) || 30)); return getDb().prepare(`SELECT day, requests, tokens_in AS tokensIn, tokens_out AS tokensOut FROM api_key_usage WHERE key_id = ? AND day >= date('now', ?) ORDER BY day DESC`).all(id, `-${safeDays - 1} days`); }
export function getRequireApiKey(defaultValue = false) { const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(SETTING); return row ? row.value === 'true' : Boolean(defaultValue); }
export function setRequireApiKey(value) { getDb().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(SETTING, value ? 'true' : 'false'); return Boolean(value); }
