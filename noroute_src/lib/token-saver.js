import { getDb } from './db.js';
import { applyRtk } from './rtk.js';

const PONYTAIL_KEY = 'token_saver.ponytail.enabled';
const RTK_KEY = 'token_saver.rtk.enabled';
const CAVEMAN_KEY = 'token_saver.caveman.enabled';
const MARKER = '[norouter token saver]';
const PONYTAIL_PROMPT = `${MARKER} Ponytail: act as an efficient lazy senior developer. Apply YAGNI: delete unnecessary work, use stdlib/native features first, reuse existing dependencies, and ship the shortest working change. Never remove validation, data-loss error handling, security, accessibility, or explicit requirements.`;
const CAVEMAN_PROMPT = `${MARKER} Caveman: reply terse and direct. Drop pleasantries, filler, and long explanations. Keep the technical substance and correctness; use minimal words.`;

function readBoolean(key, fallback = false) {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row?.value === 'true' ? true : row?.value === 'false' ? false : fallback;
}

export function getTokenSaverSettings() {
  return {
    ponytail: { enabled: readBoolean(PONYTAIL_KEY) },
    rtk: { enabled: readBoolean(RTK_KEY) },
    caveman: { enabled: readBoolean(CAVEMAN_KEY) },
  };
}

export function setTokenSaverSettings(patch = {}) {
  const current = getTokenSaverSettings();
  const next = {
    ponytail: { enabled: patch.ponytail?.enabled ?? current.ponytail.enabled },
    rtk: { enabled: patch.rtk?.enabled ?? current.rtk.enabled },
    caveman: { enabled: patch.caveman?.enabled ?? current.caveman.enabled },
  };
  for (const [key, flag] of [
    [PONYTAIL_KEY, next.ponytail.enabled],
    [RTK_KEY, next.rtk.enabled],
    [CAVEMAN_KEY, next.caveman.enabled],
  ]) {
    getDb().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(flag));
  }
  return next;
}

export function validateTokenSaverPatch(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Request body must be an object.';
  const keys = Object.keys(body);
  const allowed = new Set(['ponytail', 'rtk', 'caveman']);
  if (keys.some((key) => !allowed.has(key))) return 'Only ponytail, rtk and caveman settings are supported.';
  for (const key of keys) {
    const value = body[key];
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
      return `${key} must be an object.`;
    }
    if (value?.enabled !== undefined && typeof value.enabled !== 'boolean') {
      return `${key}.enabled must be boolean.`;
    }
  }
  return null;
}

function stripMarker(value) {
  return String(value || '').split('\n').filter((line) => !line.startsWith(MARKER)).join('\n').trim();
}

function addSystemInstruction(content, instruction) {
  if (typeof content === 'string') return [stripMarker(content), instruction].filter(Boolean).join('\n');
  if (Array.isArray(content)) {
    const parts = content.map((part) => {
      if (part?.type !== 'text' || typeof part.text !== 'string') return part;
      return { ...part, text: stripMarker(part.text) };
    }).filter((part) => part?.type !== 'text' || part.text);
    return [...parts, { type: 'text', text: instruction }];
  }
  return instruction;
}

export function applyTokenSaver(body, settings = getTokenSaverSettings()) {
  if (!Array.isArray(body?.messages)) return body;
  let result = { ...body };

  // Caveman and Ponytail are system instructions; both stack.
  const instructions = [];
  if (settings.ponytail?.enabled) instructions.push(PONYTAIL_PROMPT);
  if (settings.caveman?.enabled) instructions.push(CAVEMAN_PROMPT);
  if (instructions.length) {
    const messages = result.messages.map((message) => ({ ...message }));
    const existing = messages.find((message) => message?.role === 'system');
    const instruction = instructions.join('\n');
    if (existing) existing.content = addSystemInstruction(existing.content, instruction);
    else messages.unshift({ role: 'system', content: instruction });
    result = { ...result, messages };
  }

  // RTK compresses tool output; order-independent from the instructions above.
  result = applyRtk(result, settings);
  return result;
}

// Headroom intentionally stays out: it requires an external proxy (pip install).
export { MARKER as TOKEN_SAVER_MARKER };
