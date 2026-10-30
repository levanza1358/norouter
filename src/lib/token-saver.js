import { getDb } from './db.js';

const PONYTAIL_KEY = 'token_saver.ponytail.enabled';
const MARKER = '[norouter token saver]';
const PONYTAIL_PROMPT = `${MARKER} Ponytail: act as an efficient lazy senior developer. Apply YAGNI: delete unnecessary work, use stdlib/native features first, reuse existing dependencies, and ship the shortest working change. Never remove validation, data-loss error handling, security, accessibility, or explicit requirements.`;

function readBoolean(key, fallback = false) {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row?.value === 'true' ? true : row?.value === 'false' ? false : fallback;
}

export function getTokenSaverSettings() {
  return { ponytail: { enabled: readBoolean(PONYTAIL_KEY) } };
}

export function setTokenSaverSettings(patch = {}) {
  const enabled = patch.ponytail?.enabled ?? getTokenSaverSettings().ponytail.enabled;
  getDb().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(PONYTAIL_KEY, String(enabled));
  return { ponytail: { enabled } };
}

export function validateTokenSaverPatch(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Request body must be an object.';
  const keys = Object.keys(body);
  if (keys.some((key) => key !== 'ponytail')) return 'Only ponytail settings are supported.';
  if (body.ponytail !== undefined && (!body.ponytail || typeof body.ponytail !== 'object' || Array.isArray(body.ponytail))) {
    return 'ponytail must be an object.';
  }
  if (body.ponytail?.enabled !== undefined && typeof body.ponytail.enabled !== 'boolean') {
    return 'ponytail.enabled must be boolean.';
  }
  return null;
}

function stripMarker(value) {
  return String(value || '').split('\n').filter((line) => !line.startsWith(MARKER)).join('\n').trim();
}

function addSystemInstruction(content) {
  if (typeof content === 'string') return [stripMarker(content), PONYTAIL_PROMPT].filter(Boolean).join('\n');
  if (Array.isArray(content)) {
    const parts = content.map((part) => {
      if (part?.type !== 'text' || typeof part.text !== 'string') return part;
      return { ...part, text: stripMarker(part.text) };
    }).filter((part) => part?.type !== 'text' || part.text);
    return [...parts, { type: 'text', text: PONYTAIL_PROMPT }];
  }
  return PONYTAIL_PROMPT;
}

export function applyTokenSaver(body, settings = getTokenSaverSettings()) {
  if (!settings.ponytail?.enabled || !Array.isArray(body?.messages)) return body;
  const messages = body.messages.map((message) => ({ ...message }));
  const existing = messages.find((message) => message?.role === 'system');
  if (existing) existing.content = addSystemInstruction(existing.content);
  else messages.unshift({ role: 'system', content: PONYTAIL_PROMPT });
  return { ...body, messages };
}

// RTK and Headroom intentionally stay out: both require an external proxy or dependency.
export { MARKER as TOKEN_SAVER_MARKER };
