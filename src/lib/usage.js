// Persistent global usage. The in-memory snapshot in stats.js stays the fast
// path for the live dashboard; this module owns the SQLite history that survives
// a restart and backs the daily/weekly/monthly/all-time usage page.
//
// Buckets use the server's local timezone, so "today" means today on this
// machine. account_usage keeps its own UTC day key and is not touched here.

import { getDb } from './db.js';
import { activeRequestSnapshot } from './stats.js';

export const USAGE_RANGES = ['day', 'week', 'month', 'all'];

const pad = (value) => String(value).padStart(2, '0');

function localHourKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}`;
}

function localDayKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localMonthKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

function startOf(range, now) {
  const date = new Date(now);
  date.setMinutes(0, 0, 0);
  if (range === 'day') {
    date.setHours(0);
    return date;
  }
  if (range === 'week') {
    // Monday-first week, matching the dashboard labels.
    date.setHours(0);
    const offset = (date.getDay() + 6) % 7;
    date.setDate(date.getDate() - offset);
    return date;
  }
  if (range === 'month') {
    date.setHours(0);
    date.setDate(1);
    return date;
  }
  return null;
}

function emptyBucket(segment) {
  return { bucket: segment, requests: 0, errors: 0, tokensIn: 0, tokensOut: 0 };
}

// Every report has a fixed set of buckets: an empty hour/day/month is part of
// the story, so the chart must not silently compress gaps. Range buckets follow
// the calendar (a whole week, a whole month), not just the elapsed part.
function fillSeries(range, groupBy, firstKey, now, rows) {
  const byBucket = new Map(rows.map((row) => [row.bucket, row]));
  const series = [];
  const push = (key) => {
    const row = byBucket.get(key);
    series.push(row
      ? {
        bucket: key,
        requests: Number(row.requests || 0),
        errors: Number(row.errors || 0),
        tokensIn: Number(row.tokens_in || 0),
        tokensOut: Number(row.tokens_out || 0),
      }
      : emptyBucket(key));
  };

  if (groupBy === 'hour') {
    const cursor = new Date(firstKey);
    for (let i = 0; i < 24; i += 1) {
      push(localHourKey(cursor));
      cursor.setHours(cursor.getHours() + 1);
    }
    return series;
  }

  if (groupBy === 'day') {
    const cursor = new Date(firstKey);
    cursor.setHours(0, 0, 0, 0);
    const end = new Date(cursor);
    if (range === 'week') {
      end.setDate(end.getDate() + 6);
    } else {
      // Last day of the current month; day 0 of the next month rolls back.
      end.setMonth(end.getMonth() + 1, 0);
    }
    while (cursor <= end) {
      push(localDayKey(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    return series;
  }

  const cursor = new Date(firstKey);
  cursor.setDate(1);
  cursor.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setDate(1);
  end.setHours(0, 0, 0, 0);
  while (cursor <= end) {
    push(localMonthKey(cursor));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return series;
}

export function usageTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
  } catch {
    return 'local time';
  }
}

export function recordUsageRequest({ provider = '', model = '', usage, ms = null, at = Date.now() }) {
  const bucket = localHourKey(new Date(at));
  const tokensIn = usage?.prompt_tokens || 0;
  const tokensOut = usage?.completion_tokens || 0;
  const latency = ms == null ? 0 : Math.max(0, Math.round(ms));
  getDb().prepare(`
    INSERT INTO usage_hourly (bucket, provider, model, requests, tokens_in, tokens_out, latency_ms, latency_count)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?)
    ON CONFLICT(bucket, provider, model) DO UPDATE SET
      requests = requests + 1,
      tokens_in = tokens_in + excluded.tokens_in,
      tokens_out = tokens_out + excluded.tokens_out,
      latency_ms = latency_ms + excluded.latency_ms,
      latency_count = latency_count + excluded.latency_count
  `).run(bucket, provider || '', model || '', tokensIn, tokensOut, latency, ms == null ? 0 : 1);
}

export function recordUsageError({ provider = '', model = '', at = Date.now() }) {
  const bucket = localHourKey(new Date(at));
  getDb().prepare(`
    INSERT INTO usage_hourly (bucket, provider, model, errors)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(bucket, provider, model) DO UPDATE SET errors = errors + 1
  `).run(bucket, provider || '', model || '');
}

export function recordUsageActivity({
  at = Date.now(),
  provider = '',
  model = '',
  account = '',
  tokensIn = 0,
  tokensOut = 0,
  ms = null,
  status = null,
  ok = true,
  error = '',
} = {}) {
  getDb().prepare(`
    INSERT INTO usage_activity
      (at, provider, model, account, tokens_in, tokens_out, latency_ms, status, ok, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(at) || Date.now(),
    String(provider || '').slice(0, 120),
    String(model || '').slice(0, 240),
    String(account || '').slice(0, 160),
    Math.max(0, Number(tokensIn) || 0),
    Math.max(0, Number(tokensOut) || 0),
    ms == null ? null : Math.max(0, Math.round(Number(ms) || 0)),
    status == null ? null : Math.max(0, Math.round(Number(status) || 0)),
    ok ? 1 : 0,
    safeActivityError(error),
  );
}

function safeActivityError(value) {
  return String(value || '')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|rk|ak|sess|gho|ya29)[-_][A-Za-z0-9._-]{8,}/gi, '[redacted]')
    .slice(0, 300);
}

function activitySince(range, now) {
  const date = new Date(now);
  if (range === 'day') date.setHours(0, 0, 0, 0);
  else if (range === 'week') {
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  } else if (range === 'month') {
    date.setHours(0, 0, 0, 0);
    date.setDate(1);
  } else return 0;
  return date.getTime();
}

export function usageActivity(range = 'day', now = Date.now(), limit = 100) {
  const rows = getDb().prepare(`
    SELECT at, provider, model, account, tokens_in, tokens_out,
      latency_ms, status, ok, error
    FROM usage_activity
    WHERE at >= ?
    ORDER BY at DESC, id DESC
    LIMIT ?
  `).all(activitySince(range, now), Math.min(200, Math.max(1, Number(limit) || 100)));
  return rows.map((row) => ({
    at: new Date(Number(row.at)).toISOString(),
    provider: row.provider,
    model: row.model,
    account: row.account || null,
    tokensIn: Number(row.tokens_in || 0),
    tokensOut: Number(row.tokens_out || 0),
    ms: row.latency_ms == null ? null : Number(row.latency_ms),
    status: row.status == null ? null : Number(row.status),
    ok: Boolean(row.ok),
    error: safeActivityError(row.error) || null,
  }));
}

export function usageReport(range = 'day', now = Date.now()) {
  if (!USAGE_RANGES.includes(range)) return { error: `Unknown usage range "${range}".` };

  const db = getDb();
  const groupBy = range === 'day' ? 'hour' : range === 'all' ? 'month' : 'day';
  const width = groupBy === 'hour' ? 13 : groupBy === 'day' ? 10 : 7;

  let since = startOf(range, now);
  if (!since) {
    // All time starts at the oldest recorded hour; an empty table still gets a
    // single current-month bucket so the chart has a frame.
    const oldest = db.prepare('SELECT MIN(bucket) AS bucket FROM usage_hourly').get()?.bucket;
    since = oldest ? new Date(`${oldest}:00:00`) : new Date(now);
    since.setMinutes(0, 0, 0);
  }
  const sinceKey = localHourKey(since);

  const segment = `substr(bucket, 1, ${width})`;
  const series = db.prepare(`
    SELECT ${segment} AS bucket,
      SUM(requests) AS requests,
      SUM(errors) AS errors,
      SUM(tokens_in) AS tokens_in,
      SUM(tokens_out) AS tokens_out
    FROM usage_hourly
    WHERE bucket >= ?
    GROUP BY ${segment}
    ORDER BY bucket
  `).all(sinceKey);

  const totalsRow = db.prepare(`
    SELECT COALESCE(SUM(requests), 0) AS requests,
      COALESCE(SUM(errors), 0) AS errors,
      COALESCE(SUM(tokens_in), 0) AS tokens_in,
      COALESCE(SUM(tokens_out), 0) AS tokens_out,
      COALESCE(SUM(latency_ms), 0) AS latency_ms,
      COALESCE(SUM(latency_count), 0) AS latency_count
    FROM usage_hourly
    WHERE bucket >= ?
  `).get(sinceKey);

  const models = db.prepare(`
    SELECT provider, model,
      SUM(requests) AS requests,
      SUM(errors) AS errors,
      SUM(tokens_in) AS tokens_in,
      SUM(tokens_out) AS tokens_out,
      SUM(latency_ms) AS latency_ms,
      SUM(latency_count) AS latency_count
    FROM usage_hourly
    WHERE bucket >= ? AND model != ''
    GROUP BY provider, model
    HAVING SUM(requests) > 0 OR SUM(tokens_in) + SUM(tokens_out) > 0
    ORDER BY SUM(requests) DESC, SUM(tokens_in) + SUM(tokens_out) DESC
  `).all(sinceKey).map((row) => ({
    provider: row.provider,
    model: row.model,
    requests: Number(row.requests || 0),
    errors: Number(row.errors || 0),
    tokensIn: Number(row.tokens_in || 0),
    tokensOut: Number(row.tokens_out || 0),
    avgMs: Number(row.latency_count || 0) > 0
      ? Math.round(Number(row.latency_ms) / Number(row.latency_count))
      : null,
  }));

  const totals = {
    requests: Number(totalsRow.requests || 0),
    errors: Number(totalsRow.errors || 0),
    tokensIn: Number(totalsRow.tokens_in || 0),
    tokensOut: Number(totalsRow.tokens_out || 0),
    successRate: Number(totalsRow.requests || 0) === 0
      ? null
      : Math.round(((Number(totalsRow.requests) - Number(totalsRow.errors)) / Number(totalsRow.requests)) * 1000) / 10,
    avgMs: Number(totalsRow.latency_count || 0) > 0
      ? Math.round(Number(totalsRow.latency_ms || 0) / Number(totalsRow.latency_count))
      : null,
  };

  return {
    range,
    timeZone: usageTimeZone(),
    bucket: groupBy,
    since: sinceKey,
    totals,
    series: fillSeries(range, groupBy, since, now, series),
    models,
    activity: usageActivity(range, now, 200),
    active: activeRequestSnapshot(),
  };
}
