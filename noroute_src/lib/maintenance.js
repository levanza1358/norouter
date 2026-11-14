// Periodic account upkeep. Four tasks keep the pool honest without a request
// having to discover a stale token, an exhausted account, a missing model, or a
// proxy that stopped working: refresh tokens before they expire, re-read quota
// so "highest quota" stays accurate, re-fetch the Codex catalog, and sweep the
// proxy pool. The scheduler only starts from server.js when it is the process
// entry point, so tests never touch upstream.
import { getDb } from './db.js';
import { quotaForAccount, refreshAccountNow } from './accounts.js';
import { hasQuotaEndpoint, hasRefreshEndpoint } from './codebuddy.js';
import { catalogUrl, fetchCatalogForAccount } from './provider-catalog.js';
import { notifyWebhook } from './webhook.js';
import { getProvider, providers } from '../providers/index.js';
import { getProxySettings, proxyState } from './proxies.js';
import { runProxyTests } from './proxy-test.js';
import { scrapeProxies } from './proxy-scrape.js';

const CONFIG_KEY = 'maintenance';
const STATE_KEY = 'maintenance.state';

const MIN_INTERVAL = 5;
const MAX_INTERVAL = 1440;
const DEFAULT_SETTINGS = { enabled: true, intervalMinutes: 15 };

// Per task: how often it should run and how many accounts one run may touch.
// The limits keep a tick short on a large pool; the next tick continues where
// the previous one stopped because candidates are ordered by oldest touch.
const TOKEN_WINDOW_MS = 30 * 60_000;
const TOKEN_LIMIT = 20;
const QUOTA_LIMIT = 20;
const CATALOG_LIMIT = 10;
const PROXY_LIMIT = 10;
const PROXY_STALE_MS = 6 * 60 * 60_000;
const CONCURRENCY = 3;

const TASKS = [
  { id: 'tokens', label: 'Token refresh', everyMs: 10 * 60_000, run: runTokenRefresh },
  { id: 'quota', label: 'Quota refresh', everyMs: 6 * 60 * 60_000, run: runQuotaRefresh },
  { id: 'catalog', label: 'Model catalog', everyMs: 12 * 60 * 60_000, run: runCatalogRefresh },
  { id: 'proxy', label: 'Proxy health', everyMs: 30 * 60_000, run: runProxyUpkeep },
];

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

export function getMaintenanceSettings() {
  const raw = readJson(CONFIG_KEY);
  const interval = Number(raw?.intervalMinutes);
  return {
    enabled: raw?.enabled !== false,
    intervalMinutes: Number.isInteger(interval) && interval >= MIN_INTERVAL && interval <= MAX_INTERVAL
      ? interval
      : DEFAULT_SETTINGS.intervalMinutes,
  };
}

export function validateMaintenancePatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Body must be a JSON object.';
  const unknown = Object.keys(body).find((key) => !['enabled', 'intervalMinutes'].includes(key));
  if (unknown) return `Unknown field "${unknown}".`;
  if (!('enabled' in body) && !('intervalMinutes' in body)) return 'Nothing to update.';
  if ('enabled' in body && typeof body.enabled !== 'boolean') return 'enabled must be boolean.';
  if ('intervalMinutes' in body) {
    const value = body.intervalMinutes;
    if (!Number.isInteger(value) || value < MIN_INTERVAL || value > MAX_INTERVAL) {
      return `intervalMinutes must be an integer between ${MIN_INTERVAL} and ${MAX_INTERVAL}.`;
    }
  }
  return null;
}

export function updateMaintenanceSettings(patch = {}) {
  const current = getMaintenanceSettings();
  const next = {
    enabled: patch.enabled === undefined ? current.enabled : patch.enabled,
    intervalMinutes: patch.intervalMinutes === undefined ? current.intervalMinutes : patch.intervalMinutes,
  };
  writeMeta(CONFIG_KEY, JSON.stringify(next));
  // A changed interval must take effect now; the timer is only rebuilt when it
  // is actually running, so a test or a disabled install keeps its state.
  restartMaintenance();
  return next;
}

function readState() {
  const raw = readJson(STATE_KEY);
  const tasks = raw?.tasks && typeof raw.tasks === 'object' ? raw.tasks : {};
  return { lastTickAt: raw?.lastTickAt || null, tasks };
}

function writeState(state) {
  writeMeta(STATE_KEY, JSON.stringify(state));
}

function taskDue(task, state, now = Date.now()) {
  const last = state.tasks[task.id]?.at || 0;
  return now - last >= task.everyMs;
}

export function maintenanceSnapshot() {
  const settings = getMaintenanceSettings();
  const state = readState();
  const now = Date.now();
  return {
    settings,
    running: Boolean(timer),
    lastTickAt: state.lastTickAt,
    tasks: TASKS.map((task) => {
      const last = state.tasks[task.id] || null;
      return {
        id: task.id,
        label: task.label,
        everyMinutes: task.everyMs / 60_000,
        lastRunAt: last?.at || null,
        lastResult: last ? { ok: last.ok, summary: last.summary, ms: last.ms } : null,
        nextDueAt: last ? last.at + task.everyMs : null,
        due: taskDue(task, state, now),
      };
    }),
  };
}

// Small concurrency window: enough to finish a batch quickly without opening
// one upstream connection per account.
async function runPool(items, limit, worker) {
  const queue = items.slice();
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await worker(queue.shift());
  }));
}

function tokenCandidates(provider, now) {
  const oauth = provider.oauth || {};
  const lead = Math.max(oauth.refreshLeadMs || 0, TOKEN_WINDOW_MS);
  const maxAge = oauth.maxRefreshAgeMs || 0;
  const staleBefore = maxAge ? now - maxAge : 0;
  return getDb().prepare(`
    SELECT * FROM accounts
     WHERE provider = ? AND enabled = 1 AND refresh_token != ''
       AND ((expires_at IS NOT NULL AND expires_at > 0 AND expires_at <= ?)
         OR (last_refresh_at IS NOT NULL AND last_refresh_at > 0 AND last_refresh_at <= ?))
     ORDER BY COALESCE(last_refresh_at, 0) ASC
     LIMIT ?
  `).all(provider.id, now + lead, staleBefore, TOKEN_LIMIT);
}

async function runTokenRefresh() {
  const now = Date.now();
  let checked = 0;
  let refreshed = 0;
  let failed = 0;
  for (const provider of providers) {
    if (!provider.oauth && !hasRefreshEndpoint(provider)) continue;
    const rows = tokenCandidates(provider, now);
    checked += rows.length;
    await runPool(rows, CONCURRENCY, async (row) => {
      const result = await refreshAccountNow(provider, row).catch(() => null);
      if (result?.accessToken) refreshed += 1;
      else failed += 1;
    });
  }
  return {
    ok: failed === 0,
    summary: checked ? `${refreshed}/${checked} token${checked === 1 ? '' : 's'} refreshed` : 'No token needed a refresh.',
  };
}

async function runQuotaRefresh() {
  let checked = 0;
  let read = 0;
  let failed = 0;
  for (const provider of providers) {
    if (!provider.quota?.url && !hasQuotaEndpoint(provider)) continue;
    const rows = getDb().prepare(`
      SELECT id FROM accounts
       WHERE provider = ? AND enabled = 1
       ORDER BY COALESCE(plan_updated_at, 0) ASC
       LIMIT ?
    `).all(provider.id, QUOTA_LIMIT);
    checked += rows.length;
    await runPool(rows, CONCURRENCY, async (row) => {
      const result = await quotaForAccount(provider, row.id).catch(() => null);
      if (result?.quota) read += 1;
      else failed += 1;
    });
  }
  return {
    ok: checked === 0 || read > 0,
    summary: checked ? `${read}/${checked} quota reading${checked === 1 ? '' : 's'} updated` : 'No provider publishes quota.',
  };
}

async function runCatalogRefresh() {
  const provider = getProvider('codex');
  if (!provider || provider.modelDiscovery === false) return { ok: true, summary: 'Codex is not installed.' };
  // Accounts with the oldest catalog go first, and an account that has never
  // been fetched sorts before every account that has.
  const rows = getDb().prepare(`
    SELECT a.*, COALESCE(MAX(m.updated_at), 0) AS catalog_at
      FROM accounts a
      LEFT JOIN codex_account_models m ON m.account_id = a.id
     WHERE a.provider = 'codex' AND a.enabled = 1
     GROUP BY a.id
     ORDER BY catalog_at ASC, a.created_at ASC, a.rowid ASC
     LIMIT ?
  `).all(CATALOG_LIMIT);
  if (!rows.length) return { ok: true, summary: 'No Codex account to read.' };
  const url = catalogUrl(provider);
  let fetched = 0;
  await runPool(rows, CONCURRENCY, async (row) => {
    const result = await fetchCatalogForAccount(provider, row, url).catch(() => null);
    if (Array.isArray(result?.models)) fetched += 1;
  });
  return { ok: fetched > 0, summary: `${fetched}/${rows.length} Codex catalog${rows.length === 1 ? '' : 's'} refreshed` };
}

async function runProxyUpkeep() {
  const settings = getProxySettings();
  const parts = [];
  if (settings.enabled) {
    // Only proxies whose health is unknown or old enough to be worth a retest;
    // a 30 minute tick with 10 rows catches up a large pool over several ticks.
    const rows = getDb().prepare(`
      SELECT * FROM proxies
       WHERE enabled = 1 AND (last_checked IS NULL OR last_checked <= ?)
       ORDER BY COALESCE(last_checked, 0) ASC, created_at ASC
       LIMIT ?
    `).all(Date.now() - PROXY_STALE_MS, PROXY_LIMIT);
    await runProxyTests(rows);
    parts.push(rows.length
      ? `${rows.length} prox${rows.length === 1 ? 'y' : 'ies'} tested`
      : 'No proxy needed a test.');
  }
  const scrape = settings.scrape;
  if (scrape.auto && Date.now() - (proxyState().lastScrapeAt || 0) >= scrape.intervalMinutes * 60_000) {
    const result = await scrapeProxies({ limit: scrape.limit });
    parts.push(result.started
      ? `Scrape added ${result.scrape.added} prox${result.scrape.added === 1 ? 'y' : 'ies'}.`
      : 'Scrape already running.');
  }
  return { ok: true, summary: parts.length ? parts.join(' ') : 'Proxy upkeep is idle.' };
}

const runningTasks = new Set();
let ticking = false;
let timer = null;

async function runTask(task) {
  if (runningTasks.has(task.id)) return { id: task.id, ok: true, skipped: true, summary: 'Already running.', ms: 0 };
  runningTasks.add(task.id);
  const started = Date.now();
  try {
    const result = await task.run();
    return { id: task.id, ok: result.ok !== false, summary: result.summary, ms: Date.now() - started };
  } catch (err) {
    // A task failure is not a router failure; report it in the snapshot and let
    // the next tick retry. Only an unexpected throw reaches the webhook.
    void notifyWebhook('error', { scope: 'maintenance', task: task.id, message: err.message });
    return { id: task.id, ok: false, summary: err.message || 'Task failed.', ms: Date.now() - started };
  } finally {
    runningTasks.delete(task.id);
  }
}

export async function runMaintenance(ids = null) {
  const state = readState();
  const wanted = Array.isArray(ids) && ids.length ? new Set(ids) : null;
  const selected = TASKS.filter((task) => (wanted ? wanted.has(task.id) : taskDue(task, state)));
  const results = [];
  for (const task of selected) {
    const result = await runTask(task);
    results.push(result);
    state.tasks[task.id] = { at: Date.now(), ok: result.ok, summary: result.summary, ms: result.ms };
  }
  if (selected.length) {
    state.lastTickAt = Date.now();
    writeState(state);
  }
  return { results, snapshot: maintenanceSnapshot() };
}

async function tick() {
  if (ticking) return;
  const settings = getMaintenanceSettings();
  if (!settings.enabled) return;
  ticking = true;
  try {
    await runMaintenance();
  } finally {
    ticking = false;
  }
}

// The first tick only happens after a full interval, so starting the server
// never triggers upstream traffic immediately after a restart.
export function startMaintenance() {
  if (timer) return false;
  const { intervalMinutes } = getMaintenanceSettings();
  timer = setInterval(() => { void tick(); }, intervalMinutes * 60_000);
  timer.unref?.();
  return true;
}

export function stopMaintenance() {
  if (!timer) return false;
  clearInterval(timer);
  timer = null;
  return true;
}

export function restartMaintenance() {
  if (!timer) return false;
  stopMaintenance();
  return startMaintenance();
}
