// In-memory debug log of the last chat requests, redacted by construction:
// no Authorization headers, no tokens, no message bodies. It stores only the
// metadata an operator needs to troubleshoot routing: which provider/model
// served, which account (masked label), status, latency, and token counts.
//
// This is a ring buffer, not a replacement for usage_activity — it survives no
// restart and never touches disk, so nothing sensitive can leak into SQLite.

const MAX_ENTRIES = 200;
const MAX_ATTEMPTED = 20;

// How the served model was chosen. "direct" is the requested model (or the
// alias/rule that resolved to it); the other values name a forced chain.
export const ROUTE_REASONS = ['direct', 'combo', 'vision', 'alias', 'rule'];

const entries = [];

export function redact(value) {
  return String(value || '')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|rk|ak|sess|gho|ya29)[-_][A-Za-z0-9._-]{8,}/gi, '[redacted]');
}

function clip(value, max) {
  return String(value || '').slice(0, max) || null;
}

export function recordRequestLog(entry = {}) {
  entries.push({
    at: new Date().toISOString(),
    method: String(entry.method || 'POST'),
    path: String(entry.path || '/v1/chat/completions'),
    status: entry.status == null ? null : Math.round(Number(entry.status)),
    provider: clip(entry.provider, 120),
    model: clip(entry.model, 240),
    account: clip(entry.account, 160),
    tokensIn: Math.max(0, Number(entry.tokensIn) || 0),
    tokensOut: Math.max(0, Number(entry.tokensOut) || 0),
    ms: entry.ms == null ? null : Math.round(Number(entry.ms)),
    error: redact(entry.error).slice(0, 300) || null,
    // Routing trace: what the client asked for, why the served model was picked,
    // and which targets the chain walked before it answered. Model names only —
    // never prompts, tool arguments, or credentials.
    requested: clip(entry.requested, 240),
    route: ROUTE_REASONS.includes(entry.route) ? entry.route : null,
    via: clip(entry.via, 160),
    attempted: Array.isArray(entry.attempted)
      ? entry.attempted.slice(0, MAX_ATTEMPTED).map((name) => clip(name, 240)).filter(Boolean)
      : [],
    image: entry.image === true,
  });
  if (entries.length > MAX_ENTRIES) entries.shift();
}

export function requestLogs() {
  return [...entries];
}

export function clearRequestLogs() {
  entries.length = 0;
  return entries.length;
}
