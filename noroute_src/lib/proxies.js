import { randomBytes } from 'node:crypto';

import { getDb, transaction } from './db.js';
import { providers } from '../providers/index.js';
import { maskProxyUrl, proxyLabel } from './proxy-url.js';

const SETTINGS_KEY = 'proxy_settings';
const ASSIGNMENTS_KEY = 'proxy_assignments';
const STATE_KEY = 'proxy_state';

export const PROXY_MODES = ['global', 'direct', 'pinned'];
export const STRATEGIES = ['round-robin', 'random'];

const DEFAULT_SETTINGS = {
  enabled: false,
  strategy: 'round-robin',
  strict: false,
  autoDisableAfter: 3,
  scrape: { auto: false, intervalMinutes: 360, limit: 120 },
};

function readMeta(key) {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function writeMeta(key, value) {
  getDb().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

function readJson(key, fallback) {
  const raw = readMeta(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function cleanSettings(raw) {
  const settings = {
    ...DEFAULT_SETTINGS,
    scrape: { ...DEFAULT_SETTINGS.scrape },
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return settings;
  if (typeof raw.enabled === 'boolean') settings.enabled = raw.enabled;
  if (STRATEGIES.includes(raw.strategy)) settings.strategy = raw.strategy;
  if (typeof raw.strict === 'boolean') settings.strict = raw.strict;
  if (Number.isInteger(raw.autoDisableAfter) && raw.autoDisableAfter >= 0 && raw.autoDisableAfter <= 100) {
    settings.autoDisableAfter = raw.autoDisableAfter;
  }
  if (raw.scrape && typeof raw.scrape === 'object') {
    if (typeof raw.scrape.auto === 'boolean') settings.scrape.auto = raw.scrape.auto;
    if (Number.isInteger(raw.scrape.intervalMinutes) && raw.scrape.intervalMinutes >= 30 && raw.scrape.intervalMinutes <= 10080) {
      settings.scrape.intervalMinutes = raw.scrape.intervalMinutes;
    }
    if (Number.isInteger(raw.scrape.limit) && raw.scrape.limit >= 10 && raw.scrape.limit <= 1000) {
      settings.scrape.limit = raw.scrape.limit;
    }
  }
  return settings;
}

export function getProxySettings() {
  return cleanSettings(readJson(SETTINGS_KEY, null));
}

export function validateProxySettingsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return 'Settings must be a JSON object.';
  for (const key of ['enabled', 'strict']) {
    if (key in patch && typeof patch[key] !== 'boolean') return `${key} must be a boolean.`;
  }
  if ('strategy' in patch && !STRATEGIES.includes(patch.strategy)) return 'strategy must be round-robin or random.';
  if ('autoDisableAfter' in patch
    && (!Number.isInteger(patch.autoDisableAfter) || patch.autoDisableAfter < 0 || patch.autoDisableAfter > 100)) {
    return 'autoDisableAfter must be an integer from 0 to 100.';
  }
  if ('scrape' in patch) {
    const scrape = patch.scrape;
    if (!scrape || typeof scrape !== 'object' || Array.isArray(scrape)) return 'scrape must be an object.';
    if ('auto' in scrape && typeof scrape.auto !== 'boolean') return 'scrape.auto must be a boolean.';
    if ('intervalMinutes' in scrape
      && (!Number.isInteger(scrape.intervalMinutes) || scrape.intervalMinutes < 30 || scrape.intervalMinutes > 10080)) {
      return 'scrape.intervalMinutes must be an integer from 30 to 10080.';
    }
    if ('limit' in scrape && (!Number.isInteger(scrape.limit) || scrape.limit < 10 || scrape.limit > 1000)) {
      return 'scrape.limit must be an integer from 10 to 1000.';
    }
  }
  return '';
}

export function updateProxySettings(patch) {
  const current = getProxySettings();
  const next = { ...current, scrape: { ...current.scrape } };
  for (const key of ['enabled', 'strategy', 'strict', 'autoDisableAfter']) {
    if (key in patch) next[key] = patch[key];
  }
  if (patch.scrape) next.scrape = { ...next.scrape, ...patch.scrape };
  writeMeta(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

export function providerOptions() {
  return providers.map((provider) => ({
    id: provider.id,
    name: provider.display?.name || provider.name || provider.id,
    prefix: provider.prefix || provider.id,
  }));
}

function providerIds() {
  return new Set(providers.map((provider) => provider.id));
}

function rawAssignments() {
  const raw = readJson(ASSIGNMENTS_KEY, {});
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function cleanAssignment(value) {
  if (!value || typeof value !== 'object' || !PROXY_MODES.includes(value.mode)) {
    return { mode: 'global', proxyId: '' };
  }
  if (value.mode !== 'pinned') return { mode: value.mode, proxyId: '' };
  return { mode: 'pinned', proxyId: String(value.proxyId || '') };
}

export function getProxyAssignments() {
  const known = providerIds();
  const stored = rawAssignments();
  const out = {};
  for (const [providerId, value] of Object.entries(stored)) {
    if (!known.has(providerId)) continue;
    out[providerId] = cleanAssignment(value);
  }
  return out;
}

export function assignmentFor(providerId) {
  const stored = rawAssignments()[providerId];
  return stored ? cleanAssignment(stored) : { mode: 'global', proxyId: '' };
}

export function setProxyAssignment(providerId, mode, proxyId = '') {
  if (!providerIds().has(providerId)) return { status: 404, error: `Unknown provider "${providerId}".` };
  if (!PROXY_MODES.includes(mode)) return { status: 400, error: 'mode must be global, direct, or pinned.' };
  let id = '';
  if (mode === 'pinned') {
    id = String(proxyId || '').trim();
    const row = id ? getProxyRow(id) : null;
    if (!row || !row.enabled) return { status: 400, error: 'pinned requires an existing, enabled proxy.' };
  }
  const stored = rawAssignments();
  stored[providerId] = { mode, proxyId: id };
  writeMeta(ASSIGNMENTS_KEY, JSON.stringify(stored));
  return { assignments: getProxyAssignments() };
}

function idForProxy() {
  for (;;) {
    const id = `px_${randomBytes(4).toString('hex')}`;
    if (!getDb().prepare('SELECT 1 AS hit FROM proxies WHERE id = ?').get(id)) return id;
  }
}

export function getProxyRow(id) {
  return getDb().prepare('SELECT * FROM proxies WHERE id = ?').get(String(id || '')) || null;
}

export function proxyRows() {
  return getDb().prepare('SELECT * FROM proxies ORDER BY created_at DESC, id').all();
}

export function enabledProxyRows() {
  return getDb().prepare('SELECT * FROM proxies WHERE enabled = 1 ORDER BY created_at DESC, id').all();
}

function proxyHasAuth(row) {
  return String(row.url || '').includes('@');
}

export function publicProxy(row) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    maskedUrl: maskProxyUrl({
      protocol: row.protocol,
      host: row.host,
      port: row.port,
      hasAuth: proxyHasAuth(row),
    }),
    protocol: row.protocol,
    host: row.host,
    port: row.port,
    hasAuth: proxyHasAuth(row),
    source: row.source,
    enabled: Boolean(row.enabled),
    status: row.status,
    latencyMs: Number.isInteger(row.latency_ms) ? row.latency_ms : null,
    failCount: row.fail_count,
    lastChecked: row.last_checked ? new Date(row.last_checked).toISOString() : null,
    lastError: row.last_error || null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export function insertProxy(entry, { source = 'manual', label = '' } = {}) {
  const now = Date.now();
  const id = idForProxy();
  try {
    getDb().prepare(`INSERT INTO proxies
      (id, url, label, source, protocol, host, port, enabled, status, fail_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'unchecked', 0, ?, ?)`)
      .run(id, entry.url, proxyLabel(label, entry), source, entry.protocol, entry.host, entry.port, now, now);
  } catch (err) {
    if (/UNIQUE constraint failed: proxies\.url/.test(String(err?.message || ''))) {
      const existing = getDb().prepare('SELECT * FROM proxies WHERE url = ?').get(entry.url);
      return { duplicate: existing };
    }
    throw err;
  }
  return { proxy: getProxyRow(id) };
}

export function importProxyEntries(entries) {
  const now = Date.now();
  let added = 0;
  transaction((db) => {
    const insert = db.prepare(`INSERT OR IGNORE INTO proxies
      (id, url, label, source, protocol, host, port, enabled, status, fail_count, created_at, updated_at)
      VALUES (?, ?, ?, 'import', ?, ?, ?, 1, 'unchecked', 0, ?, ?)`);
    for (const entry of entries) {
      const result = insert.run(
        idForProxy(), entry.url, proxyLabel('', entry), entry.protocol, entry.host, entry.port, now, now,
      );
      if (result.changes) added += 1;
    }
  });
  return added;
}

export function updateProxy(id, patch) {
  const row = getProxyRow(id);
  if (!row) return null;
  const sets = [];
  const params = [];
  if ('enabled' in patch) {
    sets.push('enabled = ?');
    params.push(patch.enabled ? 1 : 0);
  }
  if ('label' in patch) {
    sets.push('label = ?');
    params.push(proxyLabel(patch.label, row));
  }
  if (!sets.length) return row;
  sets.push('updated_at = ?');
  params.push(Date.now(), row.id);
  getDb().prepare(`UPDATE proxies SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getProxyRow(id);
}

export function deleteProxy(id) {
  const row = getProxyRow(id);
  if (!row) return false;
  transaction((db) => {
    db.prepare('DELETE FROM proxies WHERE id = ?').run(id);
    const stored = rawAssignments();
    let changed = false;
    for (const [providerId, value] of Object.entries(stored)) {
      if (value?.mode === 'pinned' && value.proxyId === id) {
        stored[providerId] = { mode: 'global', proxyId: '' };
        changed = true;
      }
    }
    if (changed) writeMeta(ASSIGNMENTS_KEY, JSON.stringify(stored));
  });
  return true;
}

function fullyAvailable(row, settings) {
  if (!row || !row.enabled) return false;
  if (settings.autoDisableAfter === 0) return true;
  return row.fail_count < settings.autoDisableAfter;
}

const rotation = new Map();

// Resolves one provider request to a pool mode and, when usable, one row.
// Rotation advances once per call, so a retry that excludes the failed proxy
// naturally lands on a different row instead of the same head of the list.
export function selectProxy(providerId, excludeIds = []) {
  const settings = getProxySettings();
  if (!settings.enabled) return { mode: 'direct', candidates: [], proxy: null };
  const assignment = assignmentFor(providerId);
  if (assignment.mode === 'direct') return { mode: 'direct', candidates: [], proxy: null };

  const excluded = new Set(excludeIds.filter(Boolean));
  let rows;
  if (assignment.mode === 'pinned') {
    const row = getProxyRow(assignment.proxyId);
    rows = fullyAvailable(row, settings) ? [row] : [];
  } else {
    rows = enabledProxyRows().filter((row) => fullyAvailable(row, settings));
  }
  const candidates = rows.filter((row) => !excluded.has(row.id));
  if (!candidates.length) {
    return { mode: assignment.mode, candidates: [], proxy: null, unavailable: true };
  }
  if (assignment.mode === 'pinned') {
    return { mode: 'pinned', candidates, proxy: candidates[0] };
  }
  let index;
  if (settings.strategy === 'random') {
    index = Math.floor(Math.random() * candidates.length);
  } else {
    const cursor = rotation.get(providerId) || 0;
    index = cursor % candidates.length;
    rotation.set(providerId, cursor + 1);
  }
  return { mode: 'global', candidates, proxy: candidates[index] };
}

const stats = { proxied: 0, fallbackDirect: 0, failures: 0, lastError: null };

export function noteProxied() {
  stats.proxied += 1;
}

export function noteFallbackDirect() {
  stats.fallbackDirect += 1;
}

export function noteProxyFailure(code) {
  stats.failures += 1;
  stats.lastError = { code, at: Date.now() };
}

export function proxyStats() {
  return {
    proxied: stats.proxied,
    fallbackDirect: stats.fallbackDirect,
    failures: stats.failures,
    lastError: stats.lastError ? { ...stats.lastError } : null,
  };
}

export function markProxySuccess(id) {
  const row = getProxyRow(id);
  if (!row) return;
  if (row.fail_count === 0 && row.status === 'ok' && !row.last_error) return;
  getDb().prepare("UPDATE proxies SET status = 'ok', fail_count = 0, last_error = '', updated_at = ? WHERE id = ?")
    .run(Date.now(), id);
}

export function markProxyRequestFailure(id, code) {
  const row = getProxyRow(id);
  if (!row) return;
  getDb().prepare("UPDATE proxies SET status = 'fail', fail_count = fail_count + 1, last_error = ?, updated_at = ? WHERE id = ?")
    .run(String(code || 'connect_failed'), Date.now(), id);
}

export function recordProxyTest(id, { ok, latencyMs = null, error = '' }) {
  const row = getProxyRow(id);
  if (!row) return;
  const now = Date.now();
  if (ok) {
    getDb().prepare("UPDATE proxies SET status = 'ok', latency_ms = ?, fail_count = 0, last_checked = ?, last_error = '', updated_at = ? WHERE id = ?")
      .run(latencyMs, now, now, id);
  } else {
    getDb().prepare("UPDATE proxies SET status = 'fail', latency_ms = NULL, fail_count = fail_count + 1, last_checked = ?, last_error = ?, updated_at = ? WHERE id = ?")
      .run(now, String(error || 'connect_failed'), now, id);
  }
}

export function proxyState() {
  const raw = readJson(STATE_KEY, {});
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

export function markScrapeFinished(at = Date.now()) {
  writeMeta(STATE_KEY, JSON.stringify({ ...proxyState(), lastScrapeAt: at }));
}

function emptyTestJob() {
  return { running: false, startedAt: null, finishedAt: null, tested: 0, ok: 0, failed: 0 };
}

function emptyScrapeJob() {
  return {
    running: false,
    startedAt: null,
    finishedAt: null,
    tested: 0,
    passed: 0,
    added: 0,
    failed: 0,
    duplicates: 0,
    error: null,
    sources: [],
  };
}

let testJob = emptyTestJob();
let scrapeJob = emptyScrapeJob();

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function testJobSnapshot() {
  return {
    ...testJob,
    startedAt: iso(testJob.startedAt),
    finishedAt: iso(testJob.finishedAt),
  };
}

function scrapeJobSnapshot() {
  return {
    ...scrapeJob,
    startedAt: iso(scrapeJob.startedAt),
    finishedAt: iso(scrapeJob.finishedAt),
    sources: scrapeJob.sources.map((source) => ({ ...source })),
  };
}

export function updateTestJob(patch) {
  testJob = { ...testJob, ...patch };
  return testJobSnapshot();
}

export function resetTestJob() {
  testJob = emptyTestJob();
}

export function updateScrapeJob(patch) {
  scrapeJob = { ...scrapeJob, ...patch };
  if ('sources' in patch) scrapeJob.sources = patch.sources.map((source) => ({ ...source }));
  return scrapeJobSnapshot();
}

export function resetScrapeJob() {
  scrapeJob = emptyScrapeJob();
}

export function proxyTestJob() {
  return testJobSnapshot();
}

export function proxyScrapeJob() {
  return scrapeJobSnapshot();
}

// The scraper uses this to drop candidates already in the table before it
// spends a tunnel on them.
export function proxyUrlSet() {
  return new Set(getDb().prepare('SELECT url FROM proxies').all().map((row) => row.url));
}

export function proxySnapshot() {
  return {
    settings: getProxySettings(),
    proxies: proxyRows().map(publicProxy),
    assignments: getProxyAssignments(),
    providers: providerOptions(),
    stats: proxyStats(),
    scrape: scrapeJobSnapshot(),
    testing: testJobSnapshot(),
  };
}
