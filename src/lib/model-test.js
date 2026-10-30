import { accessTokenFor, getAccountRow, markFailure, markSuccess, pickAccount, publicAccount, updateAccount } from './accounts.js';
import { readSSEEvents } from './sse.js';
import { wireFor } from '../providers/index.js';
import { codexModelAccounts } from './codex-account.js';
import { fromResponsesStream, toResponsesRequest } from './responses-format.js';

const TEST_TIMEOUT_MS = 30_000;
export const MODEL_TEST_PROMPT = 'Hi, what your model AI ? and your training cut off ?';

function testBody(model) {
  return {
    model,
    messages: [{ role: 'user', content: MODEL_TEST_PROMPT }],
    stream: true,
  };
}

// Reads either wire. Responses SSE carries named events instead of choices, so
// deltas are translated before they reach the accumulator.
async function readProbe(stream, wireFormat) {
  let content = '';
  let error = null;
  for await (const event of readSSEEvents(stream)) {
    if (wireFormat === 'responses') {
      const mapped = fromResponsesStream(event.data);
      if (mapped.kind === 'delta') content += mapped.frame.choices[0].delta.content || '';
      if (mapped.kind === 'error' && !error) error = mapped.frame.error;
      continue;
    }
    const chunk = event.data;
    if (chunk?.error && !error) error = chunk.error;
    const delta = chunk?.choices?.[0]?.delta;
    if (typeof delta?.content === 'string') content += delta.content;
  }
  return { content, error };
}

function redact(value, token) {
  return String(value || '').replaceAll(token, '[redacted]').slice(0, 240);
}

function redactAnswer(value, token) {
  return String(value || '').replaceAll(token, '[redacted]').slice(0, 1200);
}

// The upstream body is the only place the real reason lives, so it is surfaced
// verbatim before any fallback text is allowed to hide it. shapeUnknown marks
// bodies that are not in an OpenAI `{error:{message}}` envelope.
function tryParse(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function resetLabel(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return ` · resets ${date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
}

function failureMessage(status, payload, token) {
  const parsed = typeof payload === 'string' ? tryParse(payload) : payload;
  const detail = parsed?.error && typeof parsed.error === 'object' ? parsed.error : parsed;
  const message = detail?.message ?? detail?.detail ?? parsed?.message;
  if (status === 429 && detail?.type === 'usage_limit_reached') {
    const plan = typeof detail.plan_type === 'string' && detail.plan_type.trim()
      ? ` · ${detail.plan_type.trim()} plan`
      : '';
    return `Usage limit reached${plan}${resetLabel(detail.resets_at)}`;
  }
  if (typeof message === 'string' && message.trim()) return `Provider answered ${status}: ${redact(message, token)}`;

  if (typeof parsed?.error === 'string' && parsed.error.trim()) {
    return `Provider answered ${status}: ${redact(parsed.error, token)}`;
  }
  if (parsed && Object.keys(parsed).length) {
    const compact = JSON.stringify(parsed);
    return `Provider answered ${status}: ${redact(compact.length > 400 ? `${compact.slice(0, 400)}…` : compact, token)}`;
  }

  const raw = String(payload || '').trim();
  if (raw) return `Provider answered ${status}: ${redact(raw, token)}`;
  // Nothing usable came back; say so plainly instead of inventing a reason.
  return `Provider answered ${status} with no error body. The request reached upstream and was rejected before any content was produced.`;
}

// Mirrors how /v1 picks an account so a probe never measures a different pool
// than a real request does. Mirrors matter for Codex: model access is per
// account, so a model only reachable from a Pro account must not be probed
// through a Free one.
function accountsForModel(provider, model) {
  if (provider.id !== 'codex') return null;
  const rows = codexModelAccounts(model);
  return rows.length ? rows : null;
}

function unavailableModelMessage(model, accounts) {
  if (!accounts?.length) return `No Codex account has access to "${model}". Fetch the catalog for an account or add an account that can reach it.`;
  const enabled = accounts.filter((account) => account.enabled === 1);
  if (!enabled.length) return `Codex model "${model}" has access entries, but all matching accounts are paused.`;
  const cooldown = enabled.filter((account) => account.cooldown_until > Date.now());
  if (cooldown.length === enabled.length) {
    const next = Math.min(...cooldown.map((account) => account.cooldown_until).filter(Number.isFinite));
    const when = next > Date.now() ? ` Retry after ${new Date(next).toLocaleString()}.` : '';
    return `Codex model "${model}" is rate-limited on all matching accounts.${when}`;
  }
  const errored = enabled.filter((account) => account.last_error);
  if (errored.length === enabled.length) return `Codex model "${model}" is unavailable on all matching accounts. Clear the account errors or refresh the credentials.`;
  return `No healthy Codex account is available for "${model}" right now.`;
}

async function testOne(provider, model, { disableOnError = false } = {}) {
  const eligible = accountsForModel(provider, model);
  const row = eligible
    ? eligible.find((candidate) => candidate.enabled === 1 && !candidate.last_error && candidate.cooldown_until <= Date.now())
    : pickAccount(provider.id, provider.accountStrategy);

  if (!row) {
    return {
      model,
      ok: false,
      status: 409,
      error: eligible ? unavailableModelMessage(model, eligible) : 'No active account available for model testing.',
    };
  }

  const started = Date.now();
  let account = row;
  let token = '';
  try {
    const credential = await accessTokenFor(provider, row);
    token = credential.token;
    account = credential.account || row;
    if (!token) {
      const error = 'Active account has no usable access token.';
      if (disableOnError) {
        markFailure(row.id, { message: error });
        updateAccount(row.id, { enabled: false });
      }
      return { model, ok: false, status: 401, error, account: publicAccount(getAccountRow(row.id)), disabled: disableOnError };
    }

    const { format: wireFormat, url: wireUrl } = wireFor(provider, row);
    const body = testBody(model);
    let payload = body;
    if (wireFormat === 'responses') {
      try {
        payload = toResponsesRequest(body);
      } catch (err) {
        return { model, ok: false, status: err.status || 400, error: err.message, account: publicAccount(getAccountRow(row.id)) };
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    try {
      const headers = {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...provider.headers,
        authorization: `Bearer ${token}`,
      };
      const response = await fetch(wireUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      let failureText = '';
      if (!response.ok) {
        failureText = await response.text();
        throw Object.assign(new Error(failureMessage(response.status, failureText, token)), { status: response.status, upstreamBody: failureText.slice(0, 2000) });
      }

      const result = await readProbe(response.body, wireFormat);
      if (result.error) {
        throw Object.assign(new Error(redact(result.error.message || 'Provider returned an in-stream error.', token)), { status: 502 });
      }

      markSuccess(row.id);
      return {
        model,
        ok: true,
        status: 200,
        latencyMs: Date.now() - started,
        answer: redactAnswer(result.content, token),
        account: publicAccount(getAccountRow(row.id)),
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const status = err.status || 502;
    const error = err.name === 'AbortError' ? `Model test timed out after ${TEST_TIMEOUT_MS / 1000}s.` : err.message;
    // A 400 is request-shaped: every account would reject it identically, so
    // disabling this one would take a healthy account out of rotation for a
    // problem it did not cause. Only target-shaped failures may park an account.
    const disableable = status !== 400;
    if (disableOnError && disableable) {
      markFailure(row.id, { message: error });
      updateAccount(row.id, { enabled: false });
    }
    return {
      model,
      ok: false,
      status,
      latencyMs: Date.now() - started,
      error,
      upstreamBody: err.upstreamBody || undefined,
      account: publicAccount(getAccountRow(row.id)),
      disabled: disableOnError && disableable,
    };
  }
}

export async function testProviderModels(provider, models, options = {}) {
  const list = [...new Set(models.map((model) => String(model || '').trim()).filter(Boolean))];
  if (!list.length) return { status: 400, error: 'No models to test.' };
  const results = [];
  for (const model of list) results.push(await testOne(provider, model, options));
  if (results.every((result) => result.status === 409)) {
    return { status: 409, error: results[0].error };
  }
  return {
    tested: results.length,
    passed: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    results,
  };
}
