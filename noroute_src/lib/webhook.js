// Generic webhook notifications. A fire-and-forget POST to the configured URL
// when something the operator should know about happens (a request completes,
// an error is recorded, or an account is parked). Failures are silent by
// design: a notification must never break or slow the request it describes.

import { getDb } from './db.js';

const URL_KEY = 'webhook.url';
const ENABLED_KEY = 'webhook.enabled';

const MAX_EVENTS = ['request', 'error', 'cooldown'];

function readValue(key, fallback = '') {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row == null ? fallback : row.value;
}

export function getWebhookSettings() {
  return {
    enabled: readValue(ENABLED_KEY, 'false') === 'true',
    url: readValue(URL_KEY, ''),
    events: ['request', 'error', 'cooldown'],
  };
}

export function setWebhookSettings(patch = {}) {
  const current = getWebhookSettings();
  const next = {
    enabled: patch.enabled ?? current.enabled,
    url: patch.url ?? current.url,
    events: patch.events ?? current.events,
  };
  getDb().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(ENABLED_KEY, String(Boolean(next.enabled)));
  getDb().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(URL_KEY, String(next.url || '').slice(0, 2000));
  return next;
}

export function validateWebhookPatch(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Request body must be an object.';
  const keys = Object.keys(body);
  const allowed = new Set(['enabled', 'url']);
  if (keys.some((key) => !allowed.has(key))) return 'Only enabled and url are supported.';
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') return 'enabled must be boolean.';
  if (body.url !== undefined && typeof body.url !== 'string') return 'url must be a string.';
  if (typeof body.url === 'string' && body.url) {
    try {
      const parsed = new URL(body.url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'url must be http or https.';
    } catch {
      return 'url must be a valid http(s) URL.';
    }
  }
  return null;
}

// Never send credentials. The payload is metadata only, exactly what the
// operator sees in the dashboard request log.
export async function notifyWebhook(event, detail = {}) {
  const settings = getWebhookSettings();
  if (!settings.enabled || !settings.url || !MAX_EVENTS.includes(event)) return;
  const payload = {
    event,
    at: new Date().toISOString(),
    ...detail,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(settings.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    // Best-effort: notification failures are intentionally swallowed.
  } finally {
    clearTimeout(timer);
  }
}
