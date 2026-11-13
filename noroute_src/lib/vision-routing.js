// Vision routing is a global rule for chat requests that bring a new image into
// the conversation. When enabled, the configured chain replaces whatever model
// or combo the client asked for; when disabled the request is untouched. The
// settings live in the meta table so they survive a restart without a schema
// migration.
import { getDb } from './db.js';
import { resolveModel } from './model.js';

const CONFIG_KEY = 'vision_routing';
const MAX_MODELS = 20;

export const VISION_STRATEGIES = ['order', 'round-robin'];

const EMPTY = { enabled: false, strategy: 'order', models: [] };

// Rotates the first model for round robin. It resets whenever the chain is
// saved, so a fresh configuration starts at the top of the list.
let roundRobinCursor = 0;

function readRaw() {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(CONFIG_KEY);
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

export function getVisionRouting() {
  const raw = readRaw();
  if (!raw || typeof raw !== 'object') return { ...EMPTY, models: [] };
  return {
    enabled: raw.enabled === true,
    strategy: VISION_STRATEGIES.includes(raw.strategy) ? raw.strategy : 'order',
    models: Array.isArray(raw.models)
      ? raw.models.filter((model) => typeof model === 'string' && model.trim()).map((model) => model.trim())
      : [],
  };
}

// Mirrors the combo validator: every entry must resolve to an enabled provider
// model. The canonical "prefix/model" form is what gets stored, so the same
// model cannot sneak in twice as a bare name and a prefixed one.
export function validateVisionRoutingPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Vision routing update must be a JSON object.';
  }
  const unknown = Object.keys(body).find((key) => !['enabled', 'strategy', 'models'].includes(key));
  if (unknown) return `Unknown vision routing field "${unknown}".`;
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    return 'enabled must be boolean.';
  }
  if (body.strategy !== undefined && !VISION_STRATEGIES.includes(body.strategy)) {
    return `strategy must be one of: ${VISION_STRATEGIES.join(', ')}.`;
  }
  if (body.models !== undefined) {
    if (!Array.isArray(body.models)) return 'models must be an array.';
    if (body.models.length > MAX_MODELS) {
      return `Vision routing supports at most ${MAX_MODELS} models.`;
    }
    const seen = new Set();
    for (const entry of body.models) {
      if (typeof entry !== 'string' || !entry.trim()) {
        return 'Every vision model must be a non-empty string.';
      }
      const resolved = resolveModel(entry);
      if (resolved.error) return `Invalid vision model "${entry.trim()}": ${resolved.error}`;
      const canonical = `${resolved.provider.prefix}/${resolved.model}`;
      if (seen.has(canonical)) return `Vision model "${canonical}" is listed twice.`;
      seen.add(canonical);
    }
  }
  return null;
}

export function updateVisionRouting(patch = {}) {
  const current = getVisionRouting();
  const next = {
    enabled: patch.enabled ?? current.enabled,
    strategy: patch.strategy ?? current.strategy,
    models: patch.models === undefined
      ? current.models
      : patch.models.map((entry) => {
        const resolved = resolveModel(entry);
        return `${resolved.provider.prefix}/${resolved.model}`;
      }),
  };
  // An enabled rule with no targets would silently do nothing, so refuse it.
  if (next.enabled && !next.models.length) {
    return { error: 'Add at least one vision model before enabling routing.', status: 400 };
  }
  getDb().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(CONFIG_KEY, JSON.stringify(next));
  roundRobinCursor = 0;
  return { settings: next };
}

function isImagePart(part) {
  return Boolean(part) && (part.type === 'image_url' || part.type === 'input_image' || part.type === 'image');
}

// Chat clients express images differently: OpenAI uses image_url, Responses
// uses input_image, Anthropic uses image. All three arrive in a content array.
//
// Clients resend the whole conversation on every turn, so scanning history
// would pin a conversation to the vision chain forever after one image. Only an
// image that arrives with the newest message is new input: a fresh user turn,
// or a tool result that just returned a screenshot. A tool-loop continuation
// replays the image from earlier in the same turn, and the vision chain already
// read it, so it must not be routed again.
export function hasNewImageInput(body) {
  const messages = body?.messages;
  if (!Array.isArray(messages) || !messages.length) return false;
  const newest = messages[messages.length - 1];
  return Array.isArray(newest?.content) && newest.content.some(isImagePart);
}

function messagesContainImage(body) {
  return Array.isArray(body?.messages)
    && body.messages.some((message) => Array.isArray(message?.content) && message.content.some(isImagePart));
}

// A turn without a new image keeps its requested model, but the client still
// replays images from earlier in the conversation. Providers that refuse image
// input (Upstaged answers 400) would fail on that history alone, so the caller
// drops those parts. The vision chain already answered them and its reply stays
// in the transcript.
export function stripHistoryImages(body) {
  if (!Array.isArray(body?.messages)) return body;
  let changed = false;
  const messages = body.messages.map((message) => {
    if (!Array.isArray(message?.content) || !message.content.some(isImagePart)) return message;
    changed = true;
    return {
      ...message,
      content: message.content.flatMap((part) => (isImagePart(part)
        ? [{ type: 'text', text: '[image omitted from an earlier turn]' }]
        : [part])),
    };
  });
  return changed ? { ...body, messages } : body;
}

// Returns the ordered model names for this request, or null when the rule does
// not apply. Targets that no longer resolve (model removed or disabled) are
// skipped; if none survive, the request keeps its original model instead of
// failing because of a stale configuration.
export function visionRouteFor(body) {
  const settings = getVisionRouting();
  if (!settings.enabled) return null;
  if (!hasNewImageInput(body)) {
    return messagesContainImage(body) ? { stripHistoryImages: true } : null;
  }

  const targets = [];
  const seen = new Set();
  for (const entry of settings.models) {
    const resolved = resolveModel(entry);
    if (resolved.error) continue;
    const canonical = `${resolved.provider.prefix}/${resolved.model}`;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    targets.push(canonical);
  }
  if (!targets.length) return null;

  if (settings.strategy === 'round-robin' && targets.length > 1) {
    const start = roundRobinCursor % targets.length;
    roundRobinCursor = (roundRobinCursor + 1) % 1_000_000;
    return { chain: [...targets.slice(start), ...targets.slice(0, start)] };
  }
  return { chain: targets };
}
