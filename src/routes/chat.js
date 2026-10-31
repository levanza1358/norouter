import {
  accountAttemptLimit,
  accountCounts,
  accessTokenFor,
  earliestCooldown,
  markFailure,
  markSuccess,
  pickAccount,
  refreshAccountNow,
  warmupProvider,
} from '../lib/accounts.js';
import { CORS_HEADERS, readJson, sendError, sendJson } from '../lib/http.js';
import { resolveModel } from '../lib/model.js';
import { comboModels } from '../lib/combos.js';
import { createAccumulator, readSSEEvents, stripEmptyToolCalls } from '../lib/sse.js';
import { recordApiKeyRequest, recordApiKeyTokens } from '../lib/api-keys.js';
import { recordError, recordRequest } from '../lib/stats.js';
import {
  beginActiveRequest,
  endActiveRequest,
  updateActiveRequest,
} from '../lib/stats.js';
import { recordUsageActivity, recordUsageError, recordUsageRequest } from '../lib/usage.js';
import { applyTokenSaver, getTokenSaverSettings } from '../lib/token-saver.js';
import { applyReplyFilters, getReplyFiltersSettings } from '../lib/reply-filters.js';
import { recordRequestLog } from '../lib/request-log.js';
import { notifyWebhook } from '../lib/webhook.js';
import { wireFor } from '../providers/index.js';
import { fromResponsesResponse, fromResponsesStream, toResponsesRequest } from '../lib/responses-format.js';

const AUTH_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_ATTEMPTS = 4;

function normalizeReasoning(body) {
  const direct = body.reasoning_effort ?? body.reasoning_level;
  const nested = body.thinking?.level ?? body.reasoning?.level;
  return direct ?? nested ?? null;
}

function stripHistoryReasoning(body) {
  if (!Array.isArray(body.messages)) return body;
  let changed = false;
  const messages = body.messages.map((message) => {
    if (!message || message.role !== 'assistant') return message;
    const keys = ['reasoning_content', 'reasoning', 'thinking'];
    if (!keys.some((key) => key in message)) return message;
    changed = true;
    const clean = { ...message };
    for (const key of keys) delete clean[key];
    return clean;
  });
  // Replaying old reasoning makes the model restate it instead of thinking
  // about the new turn, so the request grows and the answer gets noisier.
  return changed ? { ...body, messages } : body;
}

function mapReasoning(provider, body) {
  const config = provider.reasoning;
  const level = normalizeReasoning(body);
  const output = { ...body };
  if (!config?.enabled || level == null) return output;
  delete output.reasoning_level;
  delete output.thinking;
  delete output.reasoning;
  const normalized = String(level).toLowerCase();
  if (normalized === 'none' || normalized === 'off') {
    for (const key of Object.keys(config.mapping || {})) delete output[key];
    if (config.summary?.key) delete output[config.summary.key];
    return output;
  }
  const levels = config.levels || [];
  if (levels.length && !levels.includes(normalized)) {
    const err = new Error(`Unsupported reasoning level "${level}" for ${provider.id}. Use: ${levels.join(', ')}.`);
    err.status = 400;
    throw err;
  }
  for (const [key, value] of Object.entries(config.mapping || {})) {
    output[key] = value === '$level' ? normalized : value;
  }
  if (config.summary?.key) output[config.summary.key] = config.summary.value;
  return output;
}

export function buildHeaders(provider, token) {
  const headers = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    ...provider.headers,
  };
  // Open endpoints (a local [OI] server, for example) take no credential.
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function relayFailure(res, status, text, provider, model, account = '') {
  noteError(`Upstream ${status}: ${text.slice(0, 300)}`, {
    upstream: true,
    provider: provider.id,
    model,
    account,
    status,
  });
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { error: { message: text || 'Upstream error', type: 'upstream_error' } };
  }
  sendJson(res, status, payload);
}

// Statuses that mean "this target cannot serve the request", not "the request is
// wrong". A combo may move to the next model for these. A 400 is deliberately
// excluded: malformed bodies, context overflow and unsupported parameters would
// fail identically on every model and only bill another quota for the same bug.
function isFallbackStatus(status) {
  return status === 401
    || status === 402
    || status === 403
    || status === 404
    || status === 429
    || status >= 500;
}

// The dashboard shows live counters from stats.js; the usage page reads the
// SQLite history. Both must see every request and error, so the two are always
// recorded together here instead of at each call site.
function noteRequest({ provider, model, usage, ms, account = '', status = 200 }) {
  recordRequest({ provider, model, usage, ms });
  recordRequestLog({
    provider,
    model,
    account,
    tokensIn: usage?.prompt_tokens || 0,
    tokensOut: usage?.completion_tokens || 0,
    ms,
    status,
  });
  notifyWebhook('request', {
    provider: provider || null,
    model: model || null,
    account: account || null,
    tokensIn: usage?.prompt_tokens || 0,
    tokensOut: usage?.completion_tokens || 0,
    ms,
    status,
  });
  try {
    recordUsageRequest({ provider, model, usage, ms });
    recordUsageActivity({
      provider,
      model,
      account,
      tokensIn: usage?.prompt_tokens || 0,
      tokensOut: usage?.completion_tokens || 0,
      ms,
      status,
      ok: true,
    });
  } catch (err) {
    console.error('Usage history write failed:', err.message);
  }
}

function noteError(message, {
  upstream = false,
  model = null,
  provider = null,
  account = '',
  status = null,
  activityModel = model,
} = {}) {
  recordError(message, { upstream, model, provider });
  recordRequestLog({ provider, model, account, status, error: message });
  notifyWebhook('error', { provider: provider || null, model: model || null, account: account || null, status, message });
  try {
    recordUsageError({ provider, model });
    recordUsageActivity({ provider, model: activityModel, account, status, ok: false, error: message });
  } catch (err) {
    console.error('Usage history write failed:', err.message);
  }
}

// Every provider goes through the same relay, so a malformed delta shape is
// normalized once here instead of being special-cased per model.
function relayLine(line, acc) {
  if (!line.startsWith('data:')) return line;
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') return line;
  let chunk;
  try {
    chunk = JSON.parse(payload);
  } catch {
    // Malformed keep-alive or partial frame; forward it untouched.
    return line;
  }
  acc.feed(chunk);
  return stripEmptyToolCalls(chunk) ? `data: ${JSON.stringify(chunk)}` : line;
}

// Streams a chunk line by line to the client while feeding parsed frames into
// the accumulator, so usage and finish_reason survive a pass-through.
function tapResponsesSSE(chunk, res, acc, decoder, bufferRef) {
  bufferRef.value += decoder.decode(chunk, { stream: true });
  let out = '';
  let idx;
  while ((idx = bufferRef.value.indexOf('\n')) !== -1) {
    const raw = bufferRef.value.slice(0, idx);
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('data:')) {
      const payload = line.slice(5).trim();
      if (payload && payload !== '[DONE]') {
        try {
          const mapped = fromResponsesStream(JSON.parse(payload));
          if (mapped.kind === 'delta' || mapped.kind === 'tool_delta' || mapped.kind === 'complete' || mapped.kind === 'error') {
            acc.feed(mapped.frame);
            out += `data: ${JSON.stringify(mapped.frame)}\\n\\n`;
            if (mapped.kind === 'error') acc.feed(mapped.frame);
          }
        } catch {
          // Ignore unknown or malformed metadata events; a later failed event
          // still remains authoritative.
        }
      }
    }
    bufferRef.value = bufferRef.value.slice(idx + 1);
  }
  if (out) res.write(out);
}

function tapSSE(chunk, res, acc, decoder, bufferRef) {
  bufferRef.value += decoder.decode(chunk, { stream: true });
  let out = '';
  let idx;
  while ((idx = bufferRef.value.indexOf('\n')) !== -1) {
    const raw = bufferRef.value.slice(0, idx);
    const line = raw.replace(/\r$/, '');
    out += relayLine(line, acc) + (raw.endsWith('\r') ? '\r\n' : '\n');
    bufferRef.value = bufferRef.value.slice(idx + 1);
  }
  if (out) res.write(out);
}

function flushSSE(res, acc, decoder, bufferRef) {
  bufferRef.value += decoder.decode();
  if (!bufferRef.value) return;
  res.write(relayLine(bufferRef.value.replace(/\r$/, ''), acc));
  bufferRef.value = '';
}

function retryAfterMs(response, text) {
  const header = Number(response.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 24 * 3600_000);

  const match = String(text).match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  if (match) {
    const at = Date.parse(`${match[1]}T${match[2]}+08:00`);
    if (!Number.isNaN(at) && at > Date.now()) {
      return Math.min(at - Date.now(), 24 * 3600_000);
    }
  }
  return DEFAULT_COOLDOWN_MS;
}

// Picks the next credential from the SQLite account pool. Accounts that cannot
// produce a token are parked so the next iteration does not pick them again.
export async function resolveCredential(provider) {
  const pooled = accountCounts(provider.id).total > 0;

  if (pooled) {
    for (let attempt = 0; attempt < accountAttemptLimit(provider.id); attempt += 1) {
      const row = pickAccount(provider.id, provider.accountStrategy);
      if (!row) break;
      const { token } = await accessTokenFor(provider, row);
      if (token) return { token, row };
      markFailure(row.id, {
        message: 'Account has no usable token; add a new one.',
        cooldownMs: AUTH_COOLDOWN_MS,
      });
    }
  }

  // The normal path above never probes an account. If every pooled account is
  // parked and its cooldown has expired, warmup probes the provider quota once,
  // clears only genuinely recovered accounts, then retries normal selection.
  if (pooled) {
    await warmupProvider(provider);
    for (let attempt = 0; attempt < accountAttemptLimit(provider.id); attempt += 1) {
      const row = pickAccount(provider.id, provider.accountStrategy);
      if (!row) break;
      const { token } = await accessTokenFor(provider, row);
      if (token) return { token, row };
    }
  }

  // Providers without a token variable are open endpoints. All other providers
  // require a usable account from the SQLite pool.
  const open = !provider.requiresAccount;
  return { token: '', row: null, pooled, open };
}

export async function handleChat(req, res, settings, auth = { managedId: null }) {
  const started = Date.now();
  recordApiKeyRequest(auth.managedId);

  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    noteError(err.message);
    return sendError(res, err.status || 400, err.message);
  }

  // A combo name is checked before model resolution and is never a combo when it
  // contains "/". Array order is the fallback priority.
  const combo = comboModels(body.model);
  if (Array.isArray(combo) && combo.length) {
    return handleComboChat(req, res, settings, auth, { combo, comboName: String(body.model).trim(), body, started });
  }

  return handleSingleChat(req, res, settings, auth, { body, started, modelName: body.model });
}

// One model, end to end. Returns a plain result object instead of always writing
// to `res`, so the combo loop can decide whether to fall through to the next
// model. `res` is only touched once the outcome is known.
async function handleSingleChat(req, res, settings, auth, { body, started, modelName, deferHeaders = false, comboName = null }) {
  const resolved = resolveModel(modelName);
  if (resolved.error) {
    noteError(resolved.error);
    // A single-model request owns the response; only a combo attempt defers it.
    if (!deferHeaders) sendError(res, 400, resolved.error);
    return { ok: false, status: 400, message: resolved.error, model: null, fallback: false };
  }
  const { provider, model } = resolved;

  const credential = await resolveCredential(provider);
  const { format: wireFormat, url: wireUrl } = wireFor(provider, credential.row);
  if (!credential.token && !credential.open) {
    const message = credential.pooled
      ? `Every account for ${provider.id} is cooling down or out of tokens. Add an account or wait for the cooldown.`
      : `No account credential for ${provider.id}. Add an account on the provider page.`;
    // No upstream call happened, so this error belongs to the provider, not to a
    // model row in the usage breakdown.
    const status = credential.pooled ? 429 : 401;
    noteError(message, { provider: provider.id, status, activityModel: model });
    const cooldownAt = earliestCooldown(provider.id);
    if (!deferHeaders) {
      sendJson(res, status, {
        error: {
          message,
          type: 'invalid_request_error',
          retry_at: cooldownAt > Date.now() ? new Date(cooldownAt).toISOString() : null,
        },
      });
    }
    return { ok: false, status, message, model, fallback: isFallbackStatus(status) };
  }

  const wantsStream = body.stream === true;
  let transformedBody;
  try {
    transformedBody = mapReasoning(provider, body);
  } catch (err) {
    if (!deferHeaders) sendError(res, err.status || 400, err.message);
    return { ok: false, status: err.status || 400, message: err.message, model, fallback: false };
  }
  transformedBody = stripHistoryReasoning(transformedBody);
  transformedBody = applyTokenSaver(transformedBody, getTokenSaverSettings());
  transformedBody = applyReplyFilters(transformedBody, getReplyFiltersSettings());
  let upstreamBody = { ...transformedBody, model };
  if (wireFormat === 'responses') {
    try {
      upstreamBody = toResponsesRequest({ ...transformedBody, model });
    } catch (err) {
      if (!deferHeaders) sendError(res, err.status || 400, err.message);
      return { ok: false, status: err.status || 400, message: err.message, model, fallback: false };
    }
  }

  // The upstream only answers on a stream, so non-streaming clients get the
  // SSE buffered here and collapsed into one completion.
  if (provider.forceStream) upstreamBody.stream = true;
  if (!wantsStream && wireFormat !== 'responses') {
    upstreamBody.stream_options = {
      ...(body.stream_options || {}),
      include_usage: true,
    };
  }

  const controller = new AbortController();
  let clientGone = false;
  const onClose = () => {
    if (!res.writableEnded) {
      clientGone = true;
      controller.abort();
    }
  };
  res.on('close', onClose);
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  let activeId = null;

  const callUpstream = (payload, token) =>
    fetch(wireUrl, {

      method: 'POST',
      headers: buildHeaders(provider, token),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

  try {
    let attempt = credential;
    let upstream = null;
    let failure = null;

    // Inside a combo, account rotation stays out of the way: one model gets one
    // credential attempt, then the combo loop moves to the next model. Rotating
    // every account onto the same failing model would park the whole pool before
    // the fallback ever runs.
    const maxRounds = comboName ? 1 : MAX_ATTEMPTS;

    for (let round = 0; round < (comboName ? maxRounds : accountAttemptLimit(provider.id)); round += 1) {
      if (round > 0) {
        attempt = await resolveCredential(provider);
        if (!attempt.token) break;
      }

      let response;
      try {
        response = await callUpstream(upstreamBody, attempt.token);
      } catch (err) {
        if (clientGone || err.name === 'AbortError') throw err;
        markFailure(attempt.row?.id, { message: err.message || 'Upstream request failed.', cooldownMs: DEFAULT_COOLDOWN_MS });
        failure = { status: 502, text: err.message || 'Upstream request failed.' };
        continue;
      }

      // Some gateways reject stream_options outright. Drop it and retry once
      // rather than failing a request that would otherwise work.
      if (!response.ok && !wantsStream) {
        const text = await response.text();
        if (response.status === 400 && /stream_options/i.test(text)) {
          const retryBody = { ...upstreamBody };
          delete retryBody.stream_options;
          response = await callUpstream(retryBody, attempt.token);
        } else {
          failure = { status: response.status, text };
        }
      }

      if (response.ok) {
        upstream = response;
        break;
      }

      const text = failure?.status === response.status ? failure.text : await response.text();
      failure = { status: response.status, text };

      // A dead access token is worth one refresh before the account is parked.
      if ((response.status === 401 || response.status === 403) && attempt.row) {
        const fresh = await refreshAccountNow(provider, attempt.row);
        if (fresh?.accessToken) {
          const retry = await callUpstream(upstreamBody, fresh.accessToken);
          if (retry.ok) {
            upstream = retry;
            break;
          }
          failure = { status: retry.status, text: await retry.text() };
        }
        markFailure(attempt.row.id, {
          message: `Upstream rejected the credential (${failure.status}).`,
          cooldownMs: AUTH_COOLDOWN_MS,
        });
        continue;
      }

      if (response.status === 429 && attempt.row) {
        markFailure(attempt.row.id, {
          message: text.slice(0, 200) || 'Rate limited by upstream.',
          cooldownMs: retryAfterMs(response, text),
        });
        continue;
      }

      // A request-shaped 400 is deterministic and should not burn every account.
      // Other upstream failures park this account, then try every remaining
      // healthy account before returning the last upstream error.
      if (attempt.row && response.status !== 400) {
        markFailure(attempt.row.id, {
          message: text.slice(0, 200) || `Upstream returned ${response.status}.`,
          cooldownMs: response.status === 429 ? retryAfterMs(response, text) : DEFAULT_COOLDOWN_MS,
        });
        continue;
      }
      break;
    }

    if (!upstream) {
      if (!failure) {
        const message = `No usable credential for ${provider.id}.`;
        noteError(message, { provider: provider.id, model, status: 429 });
        if (!deferHeaders) {
          sendJson(res, 429, {
            error: {
              message,
              type: 'invalid_request_error',
              retry_at: earliestCooldown(provider.id) > Date.now()
                ? new Date(earliestCooldown(provider.id)).toISOString()
                : null,
            },
          });
        }
        return { ok: false, status: 429, message, model, fallback: true };
      }
      if (deferHeaders) {
        // Nothing has been written yet, so the caller decides: retry the next
        // combo model or relay this failure.
        return {
          ok: false,
          status: failure.status,
          message: firstMessage(failure.text),
          model,
          provider: provider.id,
          fallback: isFallbackStatus(failure.status),
        };
      }
      relayFailure(res, failure.status, failure.text, provider, model, attempt.row?.label || '');
      return { ok: false, status: failure.status, message: firstMessage(failure.text), model, fallback: isFallbackStatus(failure.status) };
    }

    const accountId = attempt.row?.id || null;
    const contentType = upstream.headers.get('content-type') || '';

    if (!wantsStream && !contentType.includes('text/event-stream')) {
      // Upstream answered with a plain JSON body; hand it over unchanged.
      const text = await upstream.text();
      let payload;
      try {
        payload = JSON.parse(text);
        if (wireFormat === 'responses') payload = fromResponsesResponse(payload);
      } catch {
        payload = { error: { message: text || 'Empty upstream response' } };
      }
      const usage = payload.usage;
      noteRequest({
        provider: provider.id,
        model,
        usage,
        ms: Date.now() - started,
        account: attempt.row?.label || '',
      });
      recordApiKeyTokens(auth.managedId, usage);
      if (accountId) {
        markSuccess(accountId, {
          tokensIn: usage?.prompt_tokens || 0,
          tokensOut: usage?.completion_tokens || 0,
        });
      }
      if (!deferHeaders) sendJson(res, 200, payload);
      return { ok: true, status: 200, payload, model, provider: provider.id };
    }

    if (wantsStream) {
      // A combo may only move on BEFORE the first byte reaches the client. The
      // upstream is already OK here, so from this point the model is locked.
      res.writeHead(200, {
        ...CORS_HEADERS,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });

      const acc = createAccumulator();
      const decoder = new TextDecoder();
      const bufferRef = { value: '' };
      activeId = beginActiveRequest({
        provider: provider.id,
        model,
        account: attempt.row?.label || '',
      });
      for await (const chunk of upstream.body) {
        if (wireFormat === 'responses') tapResponsesSSE(chunk, res, acc, decoder, bufferRef);
        else tapSSE(chunk, res, acc, decoder, bufferRef);
        if (acc.state.usage) {
          updateActiveRequest(activeId, {
            tokensIn: acc.state.usage.prompt_tokens || 0,
            tokensOut: acc.state.usage.completion_tokens || 0,
          });
        }
      }
      if (wireFormat !== 'responses') flushSSE(res, acc, decoder, bufferRef);
      res.write('data: [DONE]\\n\\n');
      res.end();
      noteRequest({
        provider: provider.id,
        model,
        usage: acc.state.usage,
        ms: Date.now() - started,
        account: attempt.row?.label || '',
      });
      recordApiKeyTokens(auth.managedId, acc.state.usage);
      if (accountId) {
        markSuccess(accountId, {
          tokensIn: acc.state.usage?.prompt_tokens || 0,
          tokensOut: acc.state.usage?.completion_tokens || 0,
        });
      }
      return { ok: true, status: 200, streamed: true, model, provider: provider.id };
    }

    const acc = createAccumulator();
    activeId = beginActiveRequest({
      provider: provider.id,
      model,
      account: attempt.row?.label || '',
    });
    for await (const event of readSSEEvents(upstream.body)) {
      acc.feed(event.data);
      if (acc.state.usage) {
        updateActiveRequest(activeId, {
          tokensIn: acc.state.usage.prompt_tokens || 0,
          tokensOut: acc.state.usage.completion_tokens || 0,
        });
      }
    }

    // A 200 stream can still carry an error frame; report it rather than hand
    // back an empty completion that looks successful.
    if (acc.state.error) {
      const message = typeof acc.state.error === 'string'
        ? acc.state.error
        : acc.state.error.message || 'Upstream reported an error';
      noteError(message, { upstream: true, model, provider: provider.id, account: attempt.row?.label || '', status: 502 });
      if (!deferHeaders) sendError(res, 502, message, { upstream: acc.state.error });
      // An in-stream error frame has no HTTP status to key off; treat it as a
      // target failure so a combo can try the next model.
      return { ok: false, status: 502, message, model, provider: provider.id, fallback: true };
    }

    const completion = acc.toCompletion(model);
    noteRequest({
      provider: provider.id,
      model,
      usage: acc.state.usage,
      ms: Date.now() - started,
      account: attempt.row?.label || '',
    });
    if (accountId) {
      markSuccess(accountId, {
        tokensIn: acc.state.usage?.prompt_tokens || 0,
        tokensOut: acc.state.usage?.completion_tokens || 0,
      });
    }
    if (!deferHeaders) sendJson(res, 200, completion);
    return { ok: true, status: 200, payload: completion, model, provider: provider.id };
  } catch (err) {
    if (clientGone || err.name === 'AbortError') {
      noteError(err.name === 'AbortError' ? 'Upstream timed out' : 'Client disconnected', {
        provider: provider.id,
        model,
        account: attempt.row?.label || '',
        status: 499,
      });
      if (!res.headersSent) {
        if (deferHeaders) return { ok: false, status: 499, message: 'Request aborted', model, fallback: false, aborted: true };
        sendError(res, 499, 'Request aborted');
      } else {
        res.end();
      }
      return { ok: false, status: 499, message: 'Request aborted', model, fallback: false, aborted: true };
    }
    if (attempt.row) {
      markFailure(attempt.row.id, {
        message: err.message || 'Upstream request failed.',
        cooldownMs: DEFAULT_COOLDOWN_MS,
      });
    }
    noteError(err.message, {
      upstream: true,
      provider: provider.id,
      model,
      account: attempt.row?.label || '',
      status: 502,
    });
    if (!res.headersSent) {
      if (deferHeaders) return { ok: false, status: 502, message: err.message, model, provider: provider.id, fallback: true };
      sendError(res, 502, `Upstream request failed: ${err.message}`);
    } else {
      res.end();
    }
    return { ok: false, status: 502, message: err.message, model, provider: provider.id, fallback: true };
  } finally {
    if (activeId != null) endActiveRequest(activeId);
    clearTimeout(timer);
    res.off('close', onClose);
  }
}

function firstMessage(text) {
  const raw = String(text || '').trim();
  if (!raw) return 'Upstream error';
  try {
    const parsed = JSON.parse(raw);
    return parsed?.error?.message || parsed?.message || raw.slice(0, 300);
  } catch {
    return raw.slice(0, 300);
  }
}

// A combo tries each real model in order. Only failures that describe the
// target (401/402/403/404/429/5xx) move to the next one; a request-shaped 400
// stops immediately so the same bad request is not billed to every model.
// Nothing is written to `res` until a model succeeds, so streaming clients never
// see bytes from a model that was abandoned.
async function handleComboChat(req, res, settings, auth, { combo, comboName, body, started }) {
  const attempts = [];
  let firstFallbackFailure = null;
  let lastFailure = null;

  for (const modelName of combo) {
    const result = await handleSingleChat(req, res, settings, auth, {
      body,
      started,
      modelName,
      deferHeaders: true,
      comboName,
    });
    if (result.ok) {
      // The winning attempt returned instead of writing, so the combo loop is
      // responsible for the single response the client receives.
      if (result.streamed) return undefined; // headers and body already sent
      sendJson(res, 200, result.payload);
      return undefined;
    }

    attempts.push(modelName);

    if (result.aborted) {
      // The client went away or the request timed out; retrying another model
      // would only waste quota.
      if (!res.headersSent) {
        sendError(res, result.status, result.message);
      } else {
        res.end();
      }
      return undefined;
    }

    lastFailure = { status: result.status, message: result.message };
    if (!firstFallbackFailure) firstFallbackFailure = { status: result.status, message: result.message };
    if (!result.fallback) break;
  }

  // A non-fallback failure (request-shaped 400) is relayed as-is; a chain where
  // every model hit a fallback status reports the first such status.
  const primary = firstFallbackFailure || lastFailure
    || { status: 502, message: 'No combo model could serve this request.' };
  const message = `Combo "${comboName}" failed. Tried: ${attempts.join(' → ')}. ${primary.message}`;
  noteError(message, { upstream: true, model: null });
  // Relay the upstream status itself (a request-shaped 400 stays 400), and only
  // promote to upstream_error when the failure really came from the server.
  const status = primary.status >= 400 && primary.status < 600 ? primary.status : 502;
  sendJson(res, status, {
    error: {
      message,
      type: status >= 500 ? 'upstream_error' : 'invalid_request_error',
      combo: comboName,
      attempted: attempts,
    },
  });
  return undefined;
}
