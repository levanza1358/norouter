import { isIP } from 'node:net';

import { parseProxyUrl } from './proxy-url.js';
import { proxyFetch } from './proxy-fetch.js';
import {
  getProxySettings,
  insertProxy,
  markScrapeFinished,
  proxyScrapeJob,
  proxyUrlSet,
  recordProxyTest,
  resetScrapeJob,
  updateScrapeJob,
} from './proxies.js';

const SOURCE_TIMEOUT_MS = 15_000;
const SCRAPE_TIMEOUT_MS = 6_000;
const SCRAPE_CONCURRENCY = 24;
const TEST_URL = 'https://www.gstatic.com/generate_204';

const PROXIFLY = 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols';
const MONOSANS = 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies';
const SPEEDX = 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master';
const GEONODE = 'https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc';

const PROXIFLY_FILES = ['http', 'https', 'socks4', 'socks5'];
const MONOSANS_FILES = ['http', 'socks4', 'socks5'];
const SPEEDX_FILES = ['http', 'socks4', 'socks5'];
const GEONODE_PROTOCOLS = ['http', 'https', 'socks4', 'socks5'];

export const SCRAPE_SOURCES = ['proxifly', 'monosans', 'thespeedx', 'geonode'];

function hostPort(ip, port) {
  const host = isIP(String(ip)) === 6 ? `[${ip}]` : String(ip);
  return `${host}:${port}`;
}

function candidate(value, fallbackProtocol) {
  let text = String(value || '').trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `${fallbackProtocol}://${text}`;
  try {
    return parseProxyUrl(text);
  } catch {
    return null;
  }
}

function textCandidates(text, protocol) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => candidate(line, protocol))
    .filter(Boolean);
}

function jsonCandidates(payload, protocol) {
  const rows = Array.isArray(payload) ? payload : [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const fromProxy = candidate(row.proxy || row.url, protocol);
    if (fromProxy) {
      out.push(fromProxy);
      continue;
    }
    if (row.ip && row.port) {
      const parsed = candidate(hostPort(row.ip, row.port), row.protocol || protocol);
      if (parsed) out.push(parsed);
    }
  }
  return out;
}

async function fetchText(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
    headers: { accept: 'text/plain' },
  });
  if (!response.ok) throw new Error('fetch_failed');
  return response.text();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error('fetch_failed');
  return response.json();
}

async function proxifly() {
  const files = await Promise.allSettled(PROXIFLY_FILES.map(async (protocol) => {
    const payload = await fetchJson(`${PROXIFLY}/${protocol}/data.json`);
    return jsonCandidates(payload, protocol);
  }));
  const entries = [];
  let failed = 0;
  for (const file of files) {
    if (file.status === 'fulfilled') entries.push(...file.value);
    else failed += 1;
  }
  return { entries, error: failed ? (failed === files.length ? 'fetch_failed' : 'partial') : null };
}

async function textSource(base, protocols) {
  const files = await Promise.allSettled(protocols.map(async (protocol) => {
    const text = await fetchText(`${base}/${protocol}.txt`);
    return textCandidates(text, protocol);
  }));
  const entries = [];
  let failed = 0;
  for (const file of files) {
    if (file.status === 'fulfilled') entries.push(...file.value);
    else failed += 1;
  }
  return { entries, error: failed ? (failed === files.length ? 'fetch_failed' : 'partial') : null };
}

async function geonode() {
  const payload = await fetchJson(GEONODE);
  const rows = Array.isArray(payload?.data) ? payload.data : null;
  if (!rows) throw new Error('parse_failed');
  const entries = [];
  for (const row of rows) {
    if (!row?.ip || !row.port) continue;
    const protocols = Array.isArray(row.protocols) ? row.protocols : ['http'];
    for (const protocol of protocols) {
      if (!GEONODE_PROTOCOLS.includes(protocol)) continue;
      const parsed = candidate(hostPort(row.ip, row.port), protocol);
      if (parsed) entries.push(parsed);
    }
  }
  return { entries, error: null };
}

const FETCHERS = {
  proxifly,
  monosans: () => textSource(MONOSANS, MONOSANS_FILES),
  thespeedx: () => textSource(SPEEDX, SPEEDX_FILES),
  geonode,
};

function setSource(id, patch) {
  const job = proxyScrapeJob();
  updateScrapeJob({ sources: job.sources.map((source) => (source.id === id ? { ...source, ...patch } : source)) });
}

function bump(patch) {
  const job = proxyScrapeJob();
  updateScrapeJob({
    tested: job.tested + (patch.tested || 0),
    passed: job.passed + (patch.passed || 0),
    added: job.added + (patch.added || 0),
    failed: job.failed + (patch.failed || 0),
    duplicates: job.duplicates + (patch.duplicates || 0),
  });
}

async function pool(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

async function validate(entry) {
  const startedAt = Date.now();
  const signal = AbortSignal.timeout(SCRAPE_TIMEOUT_MS);
  try {
    const response = await proxyFetch(entry, TEST_URL, { method: 'GET', signal });
    const ok = response.status === 204;
    try {
      await response.body?.cancel();
    } catch {
      // The candidate already has its verdict.
    }
    return ok ? { ok: true, latencyMs: Date.now() - startedAt } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function interleave(entries, limit) {
  const buckets = new Map();
  for (const entry of entries) {
    if (!buckets.has(entry.protocol)) buckets.set(entry.protocol, []);
    buckets.get(entry.protocol).push(entry);
  }
  const names = [...buckets.keys()];
  const positions = new Map(names.map((name) => [name, 0]));
  const out = [];
  while (out.length < limit) {
    let added = false;
    for (const name of names) {
      const bucket = buckets.get(name);
      const index = positions.get(name);
      if (index >= bucket.length) continue;
      out.push(bucket[index]);
      positions.set(name, index + 1);
      added = true;
      if (out.length === limit) break;
    }
    if (!added) break;
  }
  return out;
}

function candidatesFrom(results) {
  const known = proxyUrlSet();
  const seen = new Set();
  let duplicates = 0;
  const entries = [];
  for (const result of results) {
    for (const entry of result.entries) {
      if (known.has(entry.url) || seen.has(entry.url)) {
        duplicates += 1;
        continue;
      }
      seen.add(entry.url);
      entries.push(entry);
    }
  }
  return { entries, duplicates };
}

async function runScrape(sourceIds, limit) {
  try {
    const results = await Promise.all(sourceIds.map(async (id) => {
      try {
        const result = await FETCHERS[id]();
        setSource(id, {
          status: result.entries.length || !result.error ? 'ok' : 'failed',
          found: result.entries.length,
          error: result.error,
        });
        return result;
      } catch {
        setSource(id, { status: 'failed', found: 0, error: 'fetch_failed' });
        return { entries: [], error: 'fetch_failed' };
      }
    }));

    const gathered = candidatesFrom(results);
    bump({ duplicates: gathered.duplicates });
    const selected = interleave(gathered.entries, limit);

    await pool(selected, SCRAPE_CONCURRENCY, async (entry) => {
      const result = await validate(entry);
      bump(result.ok ? { tested: 1, passed: 1 } : { tested: 1, failed: 1 });
      if (!result.ok) return;
      const inserted = insertProxy(entry, { source: 'scrape' });
      if (inserted.duplicate) {
        bump({ duplicates: 1 });
        return;
      }
      recordProxyTest(inserted.proxy.id, { ok: true, latencyMs: result.latencyMs });
      bump({ added: 1 });
    });
  } catch {
    updateScrapeJob({ error: 'scrape_failed' });
  } finally {
    markScrapeFinished();
    updateScrapeJob({ running: false, finishedAt: Date.now() });
  }
  return proxyScrapeJob();
}

function beginScrape({ sources, limit } = {}) {
  if (proxyScrapeJob().running) return null;
  const chosen = Array.isArray(sources) && sources.length
    ? SCRAPE_SOURCES.filter((id) => sources.includes(id))
    : [...SCRAPE_SOURCES];
  const fallbackLimit = getProxySettings().scrape.limit;
  const capped = Math.min(1000, Math.max(10, Number.isInteger(limit) ? limit : fallbackLimit));
  resetScrapeJob();
  updateScrapeJob({
    running: true,
    startedAt: Date.now(),
    sources: chosen.map((id) => ({ id, status: 'pending', found: 0, error: null })),
  });
  return { chosen, capped };
}

export function startScrapeJob(options = {}) {
  const job = beginScrape(options);
  if (!job) return { status: 409, scrape: proxyScrapeJob() };
  void runScrape(job.chosen, job.capped);
  return { status: 202, scrape: proxyScrapeJob() };
}

// Maintenance awaits this; the route starts it without waiting.
export async function scrapeProxies(options = {}) {
  const job = beginScrape(options);
  if (!job) return { started: false, scrape: proxyScrapeJob() };
  return { started: true, scrape: await runScrape(job.chosen, job.capped) };
}
