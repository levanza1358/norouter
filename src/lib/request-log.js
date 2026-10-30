// In-memory debug log of the last chat requests, redacted by construction:
// no Authorization headers, no tokens, no message bodies. It stores only the
// metadata an operator needs to troubleshoot routing: which provider/model
// served, which account (masked label), status, latency, and token counts.
//
// This is a ring buffer, not a replacement for usage_activity — it survives no
// restart and never touches disk, so nothing sensitive can leak into SQLite.

const MAX_ENTRIES = 200;

const entries = [];

export function redact(value) {
  return String(value || '')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|rk|ak|sess|gho|ya29)[-_][A-Za-z0-9._-]{8,}/gi, '[redacted]');
}

export function recordRequestLog(entry = {}) {
  entries.push({
    at: new Date().toISOString(),
    method: String(entry.method || 'POST'),
    path: String(entry.path || '/v1/chat/completions'),
    status: entry.status == null ? null : Math.round(Number(entry.status)),
    provider: String(entry.provider || '').slice(0, 120) || null,
    model: String(entry.model || '').slice(0, 240) || null,
    account: String(entry.account || '').slice(0, 160) || null,
    tokensIn: Math.max(0, Number(entry.tokensIn) || 0),
    tokensOut: Math.max(0, Number(entry.tokensOut) || 0),
    ms: entry.ms == null ? null : Math.round(Number(entry.ms)),
    error: redact(entry.error).slice(0, 300) || null,
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
