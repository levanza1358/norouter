import { createHash, randomUUID } from 'node:crypto';

import {
  dailyCodebuddyCheckin,
  fetchCodebuddyQuota,
  hasQuotaEndpoint,
} from './codebuddy.js';
import { fetchProviderQuota } from './quota.js';
import { refreshProviderToken } from './refresh.js';
import { getDb, transaction } from './db.js';

// Accounts are the thing that scales: a pool can hold thousands of rows, so
// every read is paginated and the dashboard never receives a full token.
// Rotation is round-robin with a sticky cursor and a per-account cooldown, which
// spreads load evenly and parks a limited account instead of hammering it.

const PAGE_SIZE = 20;
const PAGE_SIZE_MAX = 200;
const REFRESH_SKEW_MS = 60_000;
const DEFAULT_COOLDOWN_MS = 60_000;
const AUTH_COOLDOWN_MS = 5 * 60_000;
const MAX_ATTEMPTS = 4;

export function accountAttemptLimit(providerId) {
  return Math.max(MAX_ATTEMPTS, candidateIds(providerId).length);
}

const cursorByProvider = new Map();
const idsByProvider = new Map();
const inflightRefresh = new Map();
const quotaOrderByAccount = new Map();

export const ACCOUNT_KINDS = ['access_token', 'refresh_token', 'api_key'];

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function maskToken(token) {
  if (!token) return '';
  if (token.length <= 12) return '••••••';
  return `${token.slice(0, 4)}••••${token.slice(-4)}`;
}

function now() {
  return Date.now();
}

export function invalidateProvider(providerId) {
  idsByProvider.delete(providerId);
  cursorByProvider.delete(providerId);
}

const invalidate = invalidateProvider;

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// The dashboard shape. Tokens are masked here and nowhere else, so a handler
// cannot accidentally serialise the raw value.
export function publicAccount(row) {
  const time = now();
  let status = 'active';
  if (!row.enabled) status = 'disabled';
  else if (row.cooldown_until > time) status = 'cooldown';
  else if (row.last_error) status = 'error';

  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    kind: row.kind,
    uid: row.uid,
    masked: maskToken(row.access_token || row.refresh_token),
    hasAccessToken: Boolean(row.access_token),
    hasRefreshToken: Boolean(row.refresh_token),
    enabled: Boolean(row.enabled),
    status,
    expiresAt: row.expires_at ?? null,
    cooldownUntil: row.cooldown_until || 0,
    lastError: row.last_error || '',
    lastUsedAt: row.last_used_at ?? null,
    requests: row.requests,
    errors: row.errors,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    plan: row.provider === 'codex' ? (row.plan || 'unknown') : null,
  };
}

export function getAccountRow(id) {
  return getDb().prepare('SELECT * FROM accounts WHERE id = ?').get(id) || null;
}

export function getAccount(id) {
  const row = getAccountRow(id);
  return row ? publicAccount(row) : null;
}

// "disabled" has no time placeholder, so each filter declares whether it needs
// the current timestamp. Passing an unused parameter makes node:sqlite throw.
const STATUS_FILTERS = {
  all: { sql: '1 = 1', time: false },
  active: { sql: "enabled = 1 AND cooldown_until <= ? AND last_error = ''", time: true },
  cooldown: { sql: 'enabled = 1 AND cooldown_until > ?', time: true },
  error: { sql: "enabled = 1 AND cooldown_until <= ? AND last_error <> ''", time: true },
  disabled: { sql: 'enabled = 0', time: false },
};

export function accountCounts(providerId) {
  const time = now();
  const row = getDb().prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN enabled = 0 THEN 1 ELSE 0 END) AS disabled,
      SUM(CASE WHEN enabled = 1 AND cooldown_until > ? THEN 1 ELSE 0 END) AS cooldown,
      SUM(CASE WHEN enabled = 1 AND cooldown_until <= ? AND last_error <> '' THEN 1 ELSE 0 END) AS error,
      SUM(CASE WHEN enabled = 1 AND cooldown_until <= ? AND last_error = '' THEN 1 ELSE 0 END) AS active
    FROM accounts WHERE provider = ?
  `).get(time, time, time, providerId);

  return {
    total: Number(row.total) || 0,
    active: Number(row.active) || 0,
    cooldown: Number(row.cooldown) || 0,
    error: Number(row.error) || 0,
    disabled: Number(row.disabled) || 0,
  };
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function providerQuotaSummary(providerId) {
  const rows = getDb().prepare('SELECT id FROM accounts WHERE provider = ?').all(providerId);
  const measured = rows
    .map(({ id }) => quotaOrderByAccount.get(id))
    .filter((quota) => quota?.hasQuota && quota.total > 0);
  if (!measured.length) return { percent: null, used: 0, total: 0, accounts: 0, updatedAt: null };
  const used = measured.reduce((sum, quota) => sum + quota.used, 0);
  const total = measured.reduce((sum, quota) => sum + quota.total, 0);
  return {
    percent: total ? Math.min(100, Math.max(0, Math.round((used / total) * 100))) : null,
    used,
    total,
    accounts: measured.length,
    updatedAt: Math.max(...measured.map((quota) => quota.checkedAt || 0)),
  };
}

export function listQuotaAccounts(providerId, options = {}) {
  const pageSize = Math.min(20, Math.max(1, Number(options.pageSize) || 5));
  const rows = getDb().prepare(
    'SELECT * FROM accounts WHERE provider = ? ORDER BY created_at, rowid',
  ).all(providerId);
  const ranked = rows.map((row, index) => {
    const cached = quotaOrderByAccount.get(row.id);
    const rank = cached?.hasQuota ? 0 : cached ? 1 : 2;
    return { row, index, rank };
  }).sort((a, b) => a.rank - b.rank || a.index - b.index);
  const total = ranked.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pages, Math.max(1, Number(options.page) || 1));
  const start = (page - 1) * pageSize;
  return {
    items: ranked.slice(start, start + pageSize).map(({ row }) => publicAccount(row)),
    total,
    page,
    pageSize,
    pages,
  };
}

function rememberQuotaOrder(id, quota) {
  const total = Number(quota?.total ?? quota?.quotas?.session?.total) || 0;
  const used = Number(quota?.used ?? quota?.quotas?.session?.used) || 0;
  quotaOrderByAccount.set(id, {
    hasQuota: Boolean(total),
    used,
    total,
    // remaining drives the highest-quota strategy. A provider that answers with
    // no packages is measured as empty rather than unknown, so it goes to the
    // back of the pool instead of ahead of accounts with real capacity.
    remaining: total ? Math.max(0, total - used) : 0,
    checkedAt: now(),
  });
}

function timestampMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
}

function exhaustedCodexQuota(quota) {
  if (!quota) return false;
  if (quota.status === 429 && quota.upstreamError?.type === 'usage_limit_reached') return true;
  if (quota.error) return false;
  if (quota.limitReached === true) return true;
  return Object.values(quota.quotas || {}).some((window) => (
    window && !window.unlimited && Number.isFinite(Number(window.used))
      && Number(window.used) >= Number(window.total || 100)
  ));
}

function quotaCooldownMs(quota, fallback = AUTH_COOLDOWN_MS) {
  const resets = [
    quota?.resets_at,
    quota?.reset_at,
    quota?.upstreamError?.resets_at,
    quota?.upstreamError?.reset_at,
    ...Object.values(quota?.quotas || {}).map((window) => window?.resetAt),
  ].map(timestampMs).filter((value) => value > now());
  return resets.length ? Math.max(1_000, Math.min(...resets) - now()) : fallback;
}

function setCodexQuotaState(id, quota, { failed = false } = {}) {
  const exhausted = failed || exhaustedCodexQuota(quota);
  if (exhausted) {
    const cooldownMs = quotaCooldownMs(quota);
    const reset = new Date(now() + cooldownMs).toISOString();
    getDb().prepare(`
      UPDATE accounts
         SET last_error = ?, cooldown_until = ?, updated_at = ?
       WHERE id = ?
    `).run(`Quota exhausted; retry after ${reset}.`, now() + cooldownMs, now(), id);
    return;
  }
  getDb().prepare(
    "UPDATE accounts SET last_error = '', cooldown_until = 0, updated_at = ? WHERE id = ?",
  ).run(now(), id);
}

export function listAccounts(providerId, options = {}) {
  const page = Math.max(1, Number(options.page) || 1);
  const pageSize = Math.min(
    PAGE_SIZE_MAX,
    Math.max(1, Number(options.pageSize) || PAGE_SIZE),
  );
  const status = STATUS_FILTERS[options.status] ? options.status : 'all';
  const filter = STATUS_FILTERS[status];
  const query = String(options.q || '').trim();

  const where = ['provider = ?', `(${filter.sql})`];
  const params = [providerId];
  if (filter.time) params.push(now());
  if (query) {
    where.push("(label LIKE ? ESCAPE '\\' OR uid LIKE ? ESCAPE '\\')");
    const like = `%${escapeLike(query)}%`;
    params.push(like, like);
  }

  const db = getDb();
  const total = Number(db.prepare(
    `SELECT COUNT(*) AS n FROM accounts WHERE ${where.join(' AND ')}`,
  ).get(...params).n) || 0;

  const rows = db.prepare(
    `SELECT * FROM accounts WHERE ${where.join(' AND ')}
     ORDER BY created_at, rowid LIMIT ? OFFSET ?`,
  ).all(...params, pageSize, (page - 1) * pageSize);

  return {
    items: rows.map(publicAccount),
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    counts: accountCounts(providerId),
  };
}

function nextLabel(providerId, uid) {
  const db = getDb();
  const base = uid ? `Account · ${uid}` : 'Account';
  if (uid) return base;
  const taken = new Set(
    db.prepare('SELECT label FROM accounts WHERE provider = ?').all(providerId).map((r) => r.label),
  );
  let n = taken.size + 1;
  while (taken.has(`Account ${n}`)) n += 1;
  return `Account ${n}`;
}

function normalise(input = {}) {
  const accessToken = String(
    input.accessToken ?? input.access_token ?? input.apiKey ?? input.api_key ?? '',
  ).trim();
  const refreshToken = String(input.refreshToken ?? input.refresh_token ?? '').trim();
  const uid = String(input.uid ?? input.userId ?? input.user_id ?? '').trim();
  const labelInput = String(input.label ?? input.name ?? '').trim();

  let kind = String(input.kind || '').trim();
  if (!ACCOUNT_KINDS.includes(kind)) {
    kind = refreshToken && !accessToken
      ? 'refresh_token'
      : accessToken.startsWith('cf-') || accessToken.startsWith('sk-')
        ? 'api_key'
        : 'access_token';
  }

  return { accessToken, refreshToken, uid, label: labelInput, kind };
}

// Validates one entry. Returns { error } or the values to insert.
function prepareEntry(input) {
  const entry = normalise(input);
  if (!entry.accessToken && !entry.refreshToken) {
    return { error: 'Provide an access token or a refresh token.' };
  }
  if (entry.label && entry.label.length > 80) {
    return { error: 'Label must be at most 80 characters.' };
  }
  if (entry.uid && entry.uid.length > 120) {
    return { error: 'uid must be at most 120 characters.' };
  }
  if (entry.accessToken.length > 8192 || entry.refreshToken.length > 8192) {
    return { error: 'Token is too long.' };
  }
  return { entry };
}

function entryFingerprint(entry) {
  const secret = entry.accessToken || entry.refreshToken;
  return hash(`${entry.kind}:${secret}`);
}

function previewEntry(entry, index, status, error = '') {
  const secret = entry.accessToken || entry.refreshToken;
  return {
    index,
    label: entry.label || '',
    uid: entry.uid || '',
    kind: entry.kind,
    masked: maskToken(secret),
    status,
    ...(error ? { error } : {}),
  };
}

export function previewAccounts(providerId, entries) {
  if (!Array.isArray(entries)) return { status: 400, error: 'Expected an array of accounts.' };
  if (entries.length > 5000) return { status: 400, error: 'Import at most 5000 accounts per request.' };

  const existing = new Set(
    getDb().prepare('SELECT fingerprint FROM accounts WHERE provider = ?').all(providerId).map((row) => row.fingerprint),
  );
  const incoming = new Set();
  const items = [];
  let fresh = 0;
  let duplicates = 0;
  let invalid = 0;

  entries.forEach((raw, index) => {
    const prepared = prepareEntry(raw);
    if (prepared.error) {
      invalid += 1;
      const entry = normalise(raw);
      items.push(previewEntry(entry, index, 'invalid', prepared.error));
      return;
    }
    const { entry } = prepared;
    const fingerprint = entryFingerprint(entry);
    if (existing.has(fingerprint)) {
      duplicates += 1;
      items.push(previewEntry(entry, index, 'duplicate'));
    } else if (incoming.has(fingerprint)) {
      duplicates += 1;
      items.push(previewEntry(entry, index, 'duplicate_input'));
    } else {
      incoming.add(fingerprint);
      fresh += 1;
      items.push(previewEntry(entry, index, 'new'));
    }
  });

  return {
    total: entries.length,
    fresh,
    duplicates,
    invalid,
    items: items.slice(0, 200),
    truncated: Math.max(0, items.length - 200),
  };
}

function insertEntry(providerId, entry, expiresIn, labelFor = null) {
  const db = getDb();
  const secret = entry.accessToken || entry.refreshToken;
  const print = hash(`${entry.kind}:${secret}`);
  const time = now();
  const expiresAt = expiresIn ? time + Number(expiresIn) * 1000 : null;
  const label = entry.label
    || (labelFor ? labelFor(entry.uid) : nextLabel(providerId, entry.uid));

  const result = db.prepare(`
    INSERT OR IGNORE INTO accounts
      (id, provider, label, kind, access_token, refresh_token, uid, fingerprint,
       enabled, expires_at, cooldown_until, last_error, last_used_at,
       requests, errors, tokens_in, tokens_out, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, '', NULL, 0, 0, 0, 0, ?, ?)
  `).run(
    randomUUID(),
    providerId,
    label,
    entry.kind,
    entry.accessToken,
    entry.refreshToken,
    entry.uid,
    print,
    expiresAt,
    time,
    time,
  );

  return Number(result.changes) > 0;
}

// Labels are cheap to guess but expensive to check one row at a time, so a bulk
// import builds the set once and hands the inserter a closure.
function bulkLabeler(providerId) {
  const taken = new Set(
    getDb().prepare('SELECT label FROM accounts WHERE provider = ?').all(providerId).map((r) => r.label),
  );
  let next = taken.size + 1;
  return (uid) => {
    if (uid) return `Account · ${uid}`;
    while (taken.has(`Account ${next}`)) next += 1;
    const label = `Account ${next}`;
    taken.add(label);
    next += 1;
    return label;
  };
}

export function createAccount(providerId, input, options = {}) {
  const prepared = prepareEntry(input);
  if (prepared.error) return { status: 400, error: prepared.error };

  const added = insertEntry(providerId, prepared.entry, options.expiresIn);
  if (!added) return { status: 409, error: 'This token is already in the pool.' };

  invalidate(providerId);
  return { added: 1 };
}

// Bulk import is the path that matters at 1,000 accounts: one transaction,
// one prepared statement, and per-entry errors instead of an all-or-nothing
// failure.
export function bulkCreateAccounts(providerId, entries) {
  if (!Array.isArray(entries)) {
    return { status: 400, error: 'Expected an array of accounts.' };
  }
  if (entries.length > 5000) {
    return { status: 400, error: 'Import at most 5000 accounts per request.' };
  }

  const invalid = [];
  const accepted = [];

  entries.forEach((raw, index) => {
    const prepared = prepareEntry(raw);
    if (prepared.error) invalid.push({ index, error: prepared.error });
    else accepted.push({ index, entry: prepared.entry, expiresIn: raw?.expiresIn ?? raw?.expires_in });
  });

  let added = 0;
  let duplicates = 0;

  transaction(() => {
    const labelFor = bulkLabeler(providerId);
    for (const item of accepted) {
      if (insertEntry(providerId, item.entry, item.expiresIn, labelFor)) added += 1;
      else duplicates += 1;
    }
  });

  invalidate(providerId);
  return { added, duplicates, invalid, total: entries.length };
}

export function updateAccount(id, patch = {}) {
  const row = getAccountRow(id);
  if (!row) return { status: 404, error: 'Account not found.' };

  const sets = [];
  const params = [];

  if (typeof patch.label === 'string') {
    const label = patch.label.trim();
    if (!label || label.length > 80) {
      return { status: 400, error: 'Label must be 1-80 characters.' };
    }
    sets.push('label = ?');
    params.push(label);
  }
  if (typeof patch.enabled === 'boolean') {
    sets.push('enabled = ?');
    params.push(patch.enabled ? 1 : 0);
    if (patch.enabled) {
      sets.push('cooldown_until = 0', "last_error = ''");
    }
  }
  if (typeof patch.accessToken === 'string' && patch.accessToken.trim()) {
    sets.push('access_token = ?', 'expires_at = NULL', "last_error = ''");
    params.push(patch.accessToken.trim());
  }
  if (typeof patch.refreshToken === 'string' && patch.refreshToken.trim()) {
    sets.push('refresh_token = ?');
    params.push(patch.refreshToken.trim());
  }
  if (patch.clearCooldown === true) {
    sets.push('cooldown_until = 0', "last_error = ''");
  }

  if (!sets.length) return { status: 400, error: 'Nothing to update.' };

  sets.push('updated_at = ?');
  params.push(now(), id);
  getDb().prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  quotaOrderByAccount.delete(id);
  invalidate(row.provider);
  return { account: getAccount(id) };
}

export function deleteAccount(id) {
  const row = getAccountRow(id);
  if (!row) return false;
  const db = getDb();
  db.prepare('DELETE FROM account_usage WHERE account_id = ?').run(id);
  db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  quotaOrderByAccount.delete(id);
  invalidate(row.provider);
  return true;
}

export function deleteAccounts(ids) {
  let removed = 0;
  transaction(() => {
    for (const id of ids) {
      if (deleteAccount(id)) removed += 1;
    }
  });
  return removed;
}

function candidateIds(providerId) {
  if (!idsByProvider.has(providerId)) {
    idsByProvider.set(
      providerId,
      getDb()
        .prepare('SELECT id FROM accounts WHERE provider = ? AND enabled = 1 ORDER BY created_at, rowid')
        .all(providerId)
        .map((r) => r.id),
    );
  }
  return idsByProvider.get(providerId);
}

// How a provider spends its account pool. Stored per provider; `round-robin`
// stays the default so existing installs keep their current behaviour.
export const ACCOUNT_STRATEGIES = ['round-robin', 'sequential', 'highest-quota'];

export function normalizeStrategy(value) {
  return ACCOUNT_STRATEGIES.includes(value) ? value : 'round-robin';
}

// A candidate is usable when it is enabled, not cooling and has no parked error.
function usableAccount(row, time) {
  if (!row) return false;
  if (row.cooldown_until > time) return false;
  if (row.last_error) return false;
  if (!row.access_token && !row.refresh_token) return false;
  return true;
}

// Rotates through the pool. Cooling and disabled accounts are skipped without
// touching the token, and the cursor only advances when an account is returned.
//
// strategy:
//   round-robin   — advance the cursor every pick (historical behaviour)
//   sequential    — keep using the first healthy account until it fails
//   highest-quota — prefer the account with the most remaining quota from the
//                   last quota read; unmeasured accounts after measured ones,
//                   and known-empty accounts last
export function pickAccount(providerId, strategy = 'round-robin') {
  const ids = candidateIds(providerId);
  if (!ids.length) return null;

  const time = now();
  const db = getDb();
  const mode = normalizeStrategy(strategy);
  const start = cursorByProvider.get(providerId) || 0;

  // Both lists hold indexes into `ids`; sequential always starts at the first
  // account in add order so a sticky cursor from another strategy cannot
  // change which account it treats as primary.
  const order = mode === 'sequential'
    ? ids.map((_, index) => index)
    : Array.from({ length: ids.length }, (_, offset) => (start + offset) % ids.length);

  if (mode === 'highest-quota') {
    // Known remaining quota first (largest wins). Accounts with no reading are
    // used after measured ones, and accounts known to be empty go last. Ties
    // rotate from the cursor so equal quotas still share load.
    const rank = (cached) => {
      if (!cached || cached.remaining == null) return 1;
      return cached.remaining > 0 ? 0 : 2;
    };
    const distance = (index) => (index - start + ids.length) % ids.length;
    const ranked = ids.map((id, index) => {
      const cached = quotaOrderByAccount.get(id);
      return { id, index, rank: rank(cached), remaining: cached?.remaining ?? -1 };
    }).sort((a, b) => a.rank - b.rank || b.remaining - a.remaining || distance(a.index) - distance(b.index));
    for (const candidate of ranked) {
      const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(candidate.id);
      if (!usableAccount(row, time)) continue;
      cursorByProvider.set(providerId, (candidate.index + 1) % ids.length);
      return row;
    }
    return null;
  }

  for (const offset of order) {
    const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(ids[offset]);
    if (!usableAccount(row, time)) continue;
    if (mode === 'round-robin') {
      cursorByProvider.set(providerId, (offset + 1) % ids.length);
    }
    // sequential keeps the cursor at 0: the first healthy account is reused
    // until it cools down or errors, then the next one takes over.
    return row;
  }
  return null;
}

// Used to answer "all accounts are cooling" with a real retry time.
export function earliestCooldown(providerId) {
  const row = getDb().prepare(
    'SELECT MIN(cooldown_until) AS at FROM accounts WHERE provider = ? AND enabled = 1',
  ).get(providerId);
  return row?.at || 0;
}

export function poolReady(providerId) {
  return candidateIds(providerId).length > 0;
}

// One credential for calls that are not chat (model discovery, a probe), with
// the same cooldown behaviour as the chat path.
export async function poolToken(provider) {
  for (let attempt = 0; attempt < accountAttemptLimit(provider.id); attempt += 1) {
    const row = pickAccount(provider.id, provider.accountStrategy);
    if (!row) return { token: '', row: null };
    const { token } = await accessTokenFor(provider, row);
    if (token) return { token, row };
    markFailure(row.id, {
      message: 'Account has no usable token; add a new one.',
      cooldownMs: AUTH_COOLDOWN_MS,
    });
  }
  return { token: '', row: null };
}

async function refreshRow(provider, row) {
  if (!row.refresh_token) return null;
  if (inflightRefresh.has(row.id)) return inflightRefresh.get(row.id);

  const promise = (async () => {
    const result = await refreshProviderToken(provider, row.refresh_token);
    if (!result || result.error) {
      const message = result?.error === 'unrecoverable_refresh_error'
        ? 'Refresh token is no longer valid. Log in again for this account.'
        : 'Could not refresh account token.';
      markFailure(row.id, { message, cooldownMs: AUTH_COOLDOWN_MS });
      return null;
    }
    if (provider.id === 'codex' && !result.refreshToken) {
      markFailure(row.id, { message: 'Provider returned no replacement refresh token; account was not updated.', cooldownMs: AUTH_COOLDOWN_MS });
      return null;
    }
    const time = now();
    const expiresAt = result.expiresIn ? time + result.expiresIn * 1000 : null;
    getDb().prepare(`
      UPDATE accounts
         SET access_token = ?, refresh_token = ?, expires_at = ?, last_refresh_at = ?,
             cooldown_until = 0, last_error = '', updated_at = ?
       WHERE id = ?
    `).run(result.accessToken, result.refreshToken || row.refresh_token, expiresAt, time, time, row.id);
    return result;
  })().finally(() => inflightRefresh.delete(row.id));

  inflightRefresh.set(row.id, promise);
  return promise;
}

// Used after an upstream 401: refresh even if the stored expiry looked fine,
// because the server can revoke an access token early.
export async function refreshAccountNow(provider, row) {
  return refreshRow(provider, row);
}

// Returns a usable Bearer token for the account, refreshing when the stored
// access token is missing or within a minute of expiring.
export async function accessTokenFor(provider, row) {
  const time = now();
  const oauth = provider.oauth;
  const stale = oauth?.trackRefreshAt && (!row.last_refresh_at || time - row.last_refresh_at >= oauth.maxRefreshAgeMs);
  const fresh = row.access_token
    && !stale
    && (!row.expires_at || row.expires_at - (oauth?.refreshLeadMs || REFRESH_SKEW_MS) > time);
  if (fresh) return { token: row.access_token, account: row };

  if (row.refresh_token) {
    const result = await refreshRow(provider, row);
    if (result?.accessToken) {
      return { token: result.accessToken, account: getAccountRow(row.id) };
    }
  }
  if (row.access_token) return { token: row.access_token, account: row };
  return { token: '', account: row };
}

export function markSuccess(id, { tokensIn = 0, tokensOut = 0 } = {}) {
  const time = now();
  const db = getDb();
  db.prepare(`
    UPDATE accounts
       SET requests = requests + 1,
           tokens_in = tokens_in + ?,
           tokens_out = tokens_out + ?,
           last_used_at = ?,
           cooldown_until = 0,
           last_error = '',
           updated_at = ?
     WHERE id = ?
  `).run(tokensIn, tokensOut, time, time, id);

  db.prepare(`
    INSERT INTO account_usage (account_id, day, requests, tokens_in, tokens_out)
    VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(account_id, day) DO UPDATE SET
      requests = requests + 1,
      tokens_in = tokens_in + excluded.tokens_in,
      tokens_out = tokens_out + excluded.tokens_out
  `).run(id, dayKey(time), tokensIn, tokensOut);
}

export function markFailure(id, { message = 'Request failed', cooldownMs = 0 } = {}) {
  const time = now();
  const until = cooldownMs ? time + cooldownMs : 0;
  getDb().prepare(`
    UPDATE accounts
       SET errors = errors + 1,
           last_error = ?,
           cooldown_until = ?,
           updated_at = ?
     WHERE id = ?
  `).run(message.slice(0, 300), until, time, id);
}

export function cooldownAccount(id, ms, reason) {
  markFailure(id, { message: reason, cooldownMs: ms || DEFAULT_COOLDOWN_MS });
}

export function clearCooldown(id) {
  const row = getAccountRow(id);
  if (!row) return false;
  getDb().prepare(
    "UPDATE accounts SET cooldown_until = 0, last_error = '', updated_at = ? WHERE id = ?",
  ).run(now(), id);
  return true;
}

// Probes one account. On CodeBuddy this hits the billing endpoint, which
// returns the real quota and rejects dead tokens without spending chat quota.
export async function testAccount(provider, id) {
  const row = getAccountRow(id);
  if (!row) return { status: 404, error: 'Account not found.' };

  const { token, account } = await accessTokenFor(provider, row);
  if (!token) {
    return { status: 400, error: 'This account has no usable token left. Refresh it or add a new one.' };
  }

  if (!provider.quota?.url && !hasQuotaEndpoint(provider)) {
    return { ok: true, message: 'Token stored. This provider has no probe endpoint.', account: publicAccount(account) };
  }

  const quota = await fetchProviderQuota(provider, token, account);
  if (quota.error) {
    const exhausted = provider.id === 'codex' && quota.status === 429;
    if (exhausted) setCodexQuotaState(id, quota, { failed: true });
    markFailure(id, { message: quota.error, cooldownMs: exhausted ? quotaCooldownMs(quota) : quota.invalid ? AUTH_COOLDOWN_MS : 0 });
    return { status: quota.invalid ? 401 : quota.status || 502, error: quota.error };
  }

  if (provider.id === 'codex') setCodexQuotaState(id, quota);
  else getDb().prepare(
    "UPDATE accounts SET last_error = '', cooldown_until = 0, updated_at = ? WHERE id = ?",
  ).run(now(), id);

  return { ok: true, quota, account: getAccount(id) };
}

export async function quotaForAccount(provider, id) {
  const row = getAccountRow(id);
  if (!row) return { status: 404, error: 'Account not found.' };
  if (!provider.quota?.url && !hasQuotaEndpoint(provider)) return { status: 400, error: 'This provider publishes no quota endpoint.' };

  const { token, account } = await accessTokenFor(provider, row);
  if (!token) return { status: 400, error: 'No usable token for this account.' };

  const quota = await fetchProviderQuota(provider, token, account);
  if (quota.error) {
    if (provider.id === 'codex' && quota.status === 429) setCodexQuotaState(id, quota, { failed: true });
    return { status: quota.invalid ? 401 : quota.status || 502, error: quota.error };
  }
  rememberQuotaOrder(id, quota);
  if (provider.id === 'codex') {
    setCodexQuotaState(id, quota);
    if (quota.plan) {
      getDb().prepare('UPDATE accounts SET plan = ?, plan_updated_at = ?, updated_at = ? WHERE id = ?')
        .run(String(quota.plan).toLowerCase(), now(), now(), id);
    }
  }
  return { quota };
}

export async function refreshQuotaOrder(provider) {
  const rows = getDb().prepare('SELECT id FROM accounts WHERE provider = ? ORDER BY created_at, rowid').all(provider.id);
  const queue = rows.slice();
  let withQuota = 0;
  let empty = 0;
  let unavailable = 0;
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length) {
      const row = queue.shift();
      const result = await quotaForAccount(provider, row.id);
      if (result.quota?.total > 0 || result.quota?.quotas?.session) withQuota += 1;
      else if (result.quota) empty += 1;
      else {
        // The probe failed, so the account is unknown rather than empty: it
        // sits between accounts with measured quota and known-empty ones.
        quotaOrderByAccount.set(row.id, { hasQuota: false, remaining: null, checkedAt: now() });
        unavailable += 1;
      }
    }
  }));
  return { total: rows.length, withQuota, empty, unavailable };
}

export async function dailyCheckinForAccount(provider, id) {
  const row = getAccountRow(id);
  if (!row) return { status: 404, error: 'Account not found.' };
  if (row.kind === 'api_key') {
    return { status: 400, error: 'Daily check-in requires an OAuth access token, not an API key.' };
  }
  if (!provider.checkin && !process.env.CODEBUDDY_CN_CHECKIN_URL?.trim()) {
    return { status: 400, error: 'This provider has no daily check-in endpoint.' };
  }

  const { token, account } = await accessTokenFor(provider, row);
  if (!token) return { status: 400, error: 'No usable OAuth token for this account.' };

  const result = await dailyCodebuddyCheckin(provider, token, account.uid);
  if (result.error) {
    if (result.invalid) markFailure(id, { message: result.error, cooldownMs: AUTH_COOLDOWN_MS });
    return { status: result.invalid ? 401 : 502, error: result.error };
  }
  return { checkin: { status: result.status, message: result.message }, account: getAccount(id) };
}

export function usageByDay(providerId, days = 14) {
  const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  return getDb().prepare(`
    SELECT u.day,
           SUM(u.requests) AS requests,
           SUM(u.tokens_in) AS tokensIn,
           SUM(u.tokens_out) AS tokensOut
      FROM account_usage u
      JOIN accounts a ON a.id = u.account_id
     WHERE a.provider = ? AND u.day >= ?
     GROUP BY u.day
     ORDER BY u.day
  `).all(providerId, since);
}

// The operator backup file. Raw tokens are included on purpose: this file is the
// credential source for a restore, so it must be handled like the database.
export function exportAccounts() {
  const rows = getDb().prepare('SELECT * FROM accounts ORDER BY provider, created_at, rowid').all();
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    accounts: rows.map((row) => ({
      provider: row.provider,
      label: row.label,
      kind: row.kind,
      access_token: row.access_token,
      refresh_token: row.refresh_token,
      uid: row.uid,
      expires_at: row.expires_at ? new Date(row.expires_at).toISOString() : null,
      enabled: Boolean(row.enabled),
    })),
  };
}

function restoreExpiresIn(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const seconds = Math.floor((ms - now()) / 1000);
  return seconds > 0 ? seconds : null;
}

// Merges a backup into the pool. Duplicates are skipped by fingerprint; existing
// accounts are never deleted. Unknown providers are counted but not written.
export function restoreAccounts(payload, knownProviderIds = new Set()) {
  const accounts = Array.isArray(payload) ? payload : payload?.accounts;
  if (!Array.isArray(accounts)) return { status: 400, error: 'Expected an accounts array.' };
  if (accounts.length > 5000) return { status: 400, error: 'Restore at most 5000 accounts per request.' };

  const byProvider = new Map();
  let unknownProviders = 0;

  for (const raw of accounts) {
    const provider = String(raw?.provider || '').trim();
    if (!provider || !knownProviderIds.has(provider)) {
      unknownProviders += 1;
      continue;
    }
    byProvider.set(provider, [
      ...(byProvider.get(provider) || []),
      {
        access_token: raw.access_token ?? raw.accessToken ?? raw.api_key ?? raw.apiKey ?? '',
        refresh_token: raw.refresh_token ?? raw.refreshToken ?? '',
        uid: raw.uid ?? '',
        label: raw.label ?? '',
        kind: raw.kind || '',
        expiresIn: restoreExpiresIn(raw.expires_at),
      },
    ]);
  }

  let added = 0;
  let duplicates = 0;
  let invalid = 0;

  for (const [provider, entries] of byProvider) {
    const result = bulkCreateAccounts(provider, entries);
    added += result.added || 0;
    duplicates += result.duplicates || 0;
    invalid += (result.invalid || []).length;
  }

  return { added, duplicates, invalid, unknownProviders, total: accounts.length };
}
