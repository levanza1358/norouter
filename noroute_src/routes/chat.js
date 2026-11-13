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
import { hasNewImageInput, stripHistoryImages, visionRouteFor } from '../lib/vision-routing.js';
import { getRoutingRules, matchRoutingRule, resolveAlias } from '../lib/routing-rules.js';
import { createAccumulator, mirrorReasoningAlias, readSSEEvents, stripEmptyToolCalls } from '../lib/sse.js';
import { containsNativeToolMarker, createNativeToolStream, recoverNativeToolCalls } from '../lib/native-tool-calls.js';
import { recordApiKeyRequest, recordApiKeyTokens } from '../lib/api-keys.js';
import { budgetGate, recordBudgetUsage } from '../lib/budgets.js';
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
import { nextLiveId, publishLive } from '../lib/live.js';
import { upstreamModelFor, wireFor, wireHeaders } from '../providers/index.js';
import { createResponsesStreamState, fromResponsesResponse, fromResponsesStream, toResponsesRequest } from '../lib/responses-format.js';
import { createAnthropicStream, fromAnthropicResponse, toAnthropicRequest } from '../lib/anthropic-format.js';
import { createAntigravityStream, fromAntigravityResponse, toAntigravityRequest } from '../lib/antigravity-format.js';

const AUTH_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_ATTEMPTS = 4;

function normalizeReasoning(body, config) {
  const direct = body.reasoning_effort ?? body.reasoning_level;
  const nested = body.thinking?.level
    ?? body.thinking?.effort
    ?? body.reasoning?.level
    ?? body.reasoning?.effort;
  const level = direct ?? nested;
  if (level != null) return level;
  // Flag-only clients pick a level through a boolean or a thinking type.
  const type = body.thinking?.type;
  if (type === 'enabled') return config?.defaultLevel ?? 'medium';
  if (type === 'disabled') return 'none';
  if (body.enable_thinking === true) return config?.defaultLevel ?? 'medium';
  if (body.enable_thinking === false) return 'none';
  return null;
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

const REASONING_ALIASES = ['reasoning_level', 'thinking', 'reasoning', 'enable_thinking'];
const OFF_LEVELS = ['none', 'off', 'disabled', 'false'];
const ON_LEVELS = ['enabled', 'on', 'true'];

function mapReasoning(provider, body) {
  const config = provider.reasoning;
  const level = normalizeReasoning(body, config);
  const output = { ...body };
  // Client dialects, not upstream parameters. Strict APIs reject these names,
  // so they are stripped even when the provider has no mapping at all.
  for (const key of REASONING_ALIASES) delete output[key];
  if (!config?.enabled) {
    // Nothing to map: the canonical reasoning_effort is passed through as-is
    // (codex later converts it to Responses reasoning.effort).
    return output;
  }
  delete output.reasoning_effort;
  if (level == null) return output;
  let normalized = String(level).toLowerCase();
  if (OFF_LEVELS.includes(normalized)) {
    for (const key of Object.keys(config.mapping || {})) delete output[key];
    if (config.summary?.key) delete output[config.summary.key];
    return output;
  }
  if (ON_LEVELS.includes(normalized)) normalized = String(config.defaultLevel ?? 'medium').toLowerCase();
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

// Embeddings and images still speak the OpenAI wire; chat passes its format so
// Anthropic-style providers get the right auth headers.
export function buildHeaders(provider, token, format = 'openai') {
  return wireHeaders(provider, token, format);
}

function relayFailure(res, status, text, provider, model, account = '', trace = null) {
  noteError(`Upstream ${status}: ${text.slice(0, 300)}`, {
    upstream: true,
    provider: provider.id,
    model,
    account,
    status,
    trace,
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
// The request log carries one routing trace per request: the model the client
// asked for, why a different one served, and the chain that was walked. It is
// metadata only, so it can be attached to both success and failure entries.
function traceFields(trace) {
  if (!trace) return {};
  return {
    requested: trace.requested,
    route: trace.route,
    via: trace.via,
    attempted: trace.attempted,
    image: trace.image,
  };
}

function noteRequest({ provider, model, usage, ms, account = '', status = 200, trace = null, keyId = null }) {
  recordRequest({ provider, model, usage, ms });
  recordRequestLog({
    provider,
    model,
    account,
    tokensIn: usage?.prompt_tokens || 0,
    tokensOut: usage?.completion_tokens || 0,
    ms,
    status,
    ...traceFields(trace),
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
    recordBudgetUsage({ keyId, provider, model, usage });
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
  trace = null,
} = {}) {
  recordError(message, { upstream, model, provider });
  recordRequestLog({ provider, model, account, status, error: message, ...traceFields(trace) });
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
  if (!payload) return line;
  if (payload === '[DONE]') {
    acc.markDone();
    return line;
  }
  let chunk;
  try {
    chunk = JSON.parse(payload);
  } catch {
    // Malformed keep-alive or partial frame; forward it untouched.
    return line;
  }
  // Normalize before feeding: the accumulator must see the canonical field the
  // client will receive, not just the upstream's alias.
  const mirrored = mirrorReasoningAlias(chunk);
  const stripped = stripEmptyToolCalls(chunk);
  // OpenAI-format upstreams can leak a native tool call as text; rewrite it
  // into a normal delta before the client (and the accumulator) sees it.
  const recovered = acc.nativeToolStream ? acc.nativeToolStream.apply(chunk) : false;
  acc.feed(chunk);
  return mirrored || stripped || recovered ? `data: ${JSON.stringify(chunk)}` : line;
}

// Streams a chunk line by line to the client while feeding parsed frames into
// the accumulator, so usage and finish_reason survive a pass-through.
function relayResponsesLine(line, acc) {
  if (!line.startsWith('data:')) return '';
  const payload = line.slice(5).trim();
  if (!payload) return '';
  if (payload === '[DONE]') {
    acc.markDone();
    return '';
  }
  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    // Ignore unknown or malformed metadata events; a later failed event still
    // remains authoritative.
    return '';
  }
  // An incomplete response is a deliberate upstream ending (token cap, content
  // filter), not a truncated connection: accept it as terminal, but do not
  // invent a finish frame the Responses wire never sent.
  if (event?.type === 'response.incomplete') acc.markDone();
  const mapped = fromResponsesStream(event, acc.responsesStream);
  if (mapped.kind !== 'delta' && mapped.kind !== 'tool_delta' && mapped.kind !== 'complete' && mapped.kind !== 'error') {
    return '';
  }
  acc.feed(mapped.frame);
  return `data: ${JSON.stringify(mapped.frame)}\n\n`;
}

function tapResponsesSSE(chunk, res, acc, decoder, bufferRef) {
  acc.responsesStream ||= createResponsesStreamState();
  bufferRef.value += decoder.decode(chunk, { stream: true });
  let out = '';
  let idx;
  while ((idx = bufferRef.value.indexOf('\n')) !== -1) {
    const raw = bufferRef.value.slice(0, idx);
    out += relayResponsesLine(raw.replace(/\r$/, ''), acc);
    bufferRef.value = bufferRef.value.slice(idx + 1);
  }
  if (out) res.write(out);
}

// Last frame without a trailing newline: parse it instead of dropping it. A
// partial JSON body is ignored because relaying half a frame breaks the client.
function flushResponsesSSE(res, acc, decoder, bufferRef) {
  bufferRef.value += decoder.decode();
  if (!bufferRef.value) return;
  const line = bufferRef.value.replace(/\r$/, '');
  bufferRef.value = '';
  const out = relayResponsesLine(line, acc);
  if (out) res.write(out);
}

// Translated formats (Anthropic, Antigravity) are converted into OpenAI chunks
// before they reach the client, so clients only ever see the Chat Completions
// SSE shape.
function relayTranslatedLine(line, acc, translator) {
  if (!line.startsWith('data:')) return '';
  const payload = line.slice(5).trim();
  if (!payload) return '';
  if (payload === '[DONE]') {
    acc.markDone();
    return '';
  }
  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return '';
  }
  let out = '';
  for (const frame of translator.push(event)) {
    acc.feed(frame);
    out += `data: ${JSON.stringify(frame)}\n\n`;
  }
  return out;
}

function tapTranslatedSSE(chunk, res, acc, decoder, bufferRef, translator) {
  bufferRef.value += decoder.decode(chunk, { stream: true });
  let out = '';
  let idx;
  while ((idx = bufferRef.value.indexOf('\n')) !== -1) {
    const raw = bufferRef.value.slice(0, idx);
    bufferRef.value = bufferRef.value.slice(idx + 1);
    out += relayTranslatedLine(raw.replace(/\r$/, ''), acc, translator);
  }
  if (out) res.write(out);
}

function flushTranslatedSSE(res, acc, decoder, bufferRef, translator) {
  bufferRef.value += decoder.decode();
  if (!bufferRef.value) return;
  const line = bufferRef.value.replace(/\r$/, '');
  bufferRef.value = '';
  const out = relayTranslatedLine(line, acc, translator);
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
    // SSE dispatches an event on a blank line. Track whether the last relayed
    // line closed one, so the synthetic [DONE] is never glued onto a frame the
    // upstream ended without a trailing newline.
    acc.sseOpen = line !== '';
    bufferRef.value = bufferRef.value.slice(idx + 1);
  }
  if (out) res.write(out);
}

function flushSSE(res, acc, decoder, bufferRef) {
  bufferRef.value += decoder.decode();
  let out = '';
  if (bufferRef.value) {
    const line = bufferRef.value.replace(/\r$/, '');
    bufferRef.value = '';
    if (line.startsWith('data:')) {
      // A final data line without a newline is a complete frame when it parses;
      // a partial JSON body is a truncated frame and is dropped instead of being
      // concatenated with the synthetic [DONE] into one malformed event.
      const payload = line.slice(5).trim();
      let parseable = !payload;
      if (payload) {
        if (payload === '[DONE]') parseable = true;
        else {
          try {
            JSON.parse(payload);
            parseable = true;
          } catch {
            parseable = false;
          }
        }
      }
      if (parseable) out += relayLine(line, acc) + '\n\n';
    } else {
      out += relayLine(line, acc) + '\n\n';
    }
    acc.sseOpen = false;
  } else if (acc.sseOpen) {
    out += '\n';
    acc.sseOpen = false;
  }
  if (out) res.write(out);
}

// A streamed client only understands SSE, so a mid-stream failure has to take
// the shape of an error frame; a bare close reads as a finished, empty answer.
function writeStreamErrorFrame(res, code, message) {
  if (res.destroyed || res.writableEnded) return;
  res.write(`data: ${JSON.stringify({ error: { message, type: 'upstream_error', code } })}\n\n`);
  res.end();
}

// A streamed turn that already sent headers cannot fall back to another model,
// so the only honest ending is one OpenAI-shaped error frame and no synthetic
// [DONE]. Nothing is marked successful: a cut connection must not look like a
// finished answer, and it must not park the account either.
function failStreamedTurn(res, acc, { code, provider, model, account, liveId, trace = null }) {
  const message = code === 'stream_error'
    ? (typeof acc.state.error === 'string'
      ? acc.state.error
      : acc.state.error?.message || 'Upstream reported an error')
    : `Upstream stream ended before completion (${provider.id}/${model}).`;
  writeStreamErrorFrame(res, code, message);
  noteError(message, { upstream: true, provider: provider.id, model, account, status: 502, trace });
  publishLive({
    phase: 'error',
    id: liveId,
    at: Date.now(),
    provider: provider.id,
    model,
    status: 502,
    stage: 'upstream',
  });
  return { ok: false, status: 502, message, model, provider: provider.id, fallback: false };
}

// A successful turn with no text and no tool call is the signature of a client
// that "just stops": the model finished, but there was nothing to render. Log
// provider/model only; prompt and response text never reach the log.
function noteCompletionHealth({ provider, model, content, toolCalls = 0, reasoning = '', stream = false, recovery = false }) {
  const text = typeof content === 'string' ? content : '';
  if (recovery && containsNativeToolMarker(text)) {
    console.warn(`[chat] native tool-call marker left in content provider=${provider.id} model=${model}`);
  }
  if (!text && toolCalls === 0) {
    console.warn(`[chat] empty completion provider=${provider.id} model=${model} stream=${Boolean(stream)} reasoning=${Boolean(reasoning)}`);
  }
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

// One shape for every successful outcome; the map only needs counts and the
// tool flag, never the response text.
function publishFinish({ liveId, provider, model, usage, ms, tool = false, stream = false, kind = 'chat' }) {
  publishLive({
    phase: 'finish',
    id: liveId,
    at: Date.now(),
    provider,
    model,
    status: 200,
    ms,
    tokensIn: usage?.prompt_tokens || 0,
    tokensOut: usage?.completion_tokens || 0,
    tool,
    stream,
    kind,
  });
}

function budgetMessage(blocked, subject) {
  const parts = [];
  if (blocked.reasons.includes('tokens')) parts.push(`tokens ${blocked.used.tokens}/${blocked.limit.tokens}`);
  if (blocked.reasons.includes('cost')) parts.push(`cost $${blocked.used.cost.toFixed(2)}/$${blocked.limit.cost.toFixed(2)}`);
  return `Daily budget reached for ${subject} (${parts.join(', ')}). It resets at local midnight.`;
}

function budgetErrorBody(blocked, message) {
  return {
    error: {
      message,
      type: 'budget_error',
      code: 'budget_exhausted',
      scope: blocked.scope,
      day: blocked.day,
      reasons: blocked.reasons,
      limit: blocked.limit,
      used: {
        requests: blocked.used.requests,
        tokens: blocked.used.tokens,
        tokensIn: blocked.used.tokensIn,
        tokensOut: blocked.used.tokensOut,
        cost: Number(blocked.used.cost.toFixed(6)),
      },
    },
  };
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

  // The service map counts this request from the moment the body is known, so
  // the client node moves before model resolution can fail.
  const liveId = nextLiveId();
  publishLive({
    phase: 'start',
    id: liveId,
    at: Date.now(),
    kind: 'chat',
    model: typeof body?.model === 'string' ? body.model : '',
    stream: body?.stream === true,
    tools: Array.isArray(body?.tools) && body.tools.length > 0,
  });

  // Routing trace for the request log. The requested model is captured before
  // any rule, combo, or alias rewrites it, so "why did my request switch model"
  // is answerable from the UI instead of from upstream bills.
  const trace = {
    requested: typeof body?.model === 'string' ? body.model.trim() : '',
    route: 'direct',
    via: null,
    image: hasNewImageInput(body),
    attempted: [],
  };

  // A managed key with a daily budget stops here, before any rule or vision
  // chain spends an upstream call. Unmanaged /api traffic has no key scope.
  if (auth?.managedId) {
    const blocked = budgetGate(`key:${auth.managedId}`);
    if (blocked) {
      const message = budgetMessage(blocked, 'this API key');
      noteError(message, { status: 429, trace });
      publishLive({ phase: 'error', id: liveId, at: Date.now(), status: 429, stage: 'budget' });
      return sendJson(res, 429, budgetErrorBody(blocked, message));
    }
  }

  // Vision routing is a global override: when it is enabled and the newest
  // message brings an image, the configured chain replaces whatever model or
  // combo the client asked for. A disabled rule leaves the request alone.
  const vision = visionRouteFor(body);
  if (vision?.chain) {
    trace.route = 'vision';
    return handleModelChain(req, res, settings, auth, {
      chain: vision.chain,
      failureLabel: 'Vision routing',
      errorFields: { vision: true },
      body,
      started,
      liveId,
      trace,
    });
  }
  // Rule on, no new image (a text-only turn or a tool-loop continuation): the
  // request keeps its own model. Drop the replayed images so a provider that
  // refuses image input does not 400 on history alone; the vision chain already
  // answered them.
  if (vision?.stripHistoryImages) body = stripHistoryImages(body);

  // A managed key can carry a default model. It applies only when the client
  // sent no model at all, so an explicit request never gets overridden.
  if ((typeof body?.model !== 'string' || !body.model.trim()) && auth?.defaultModel) {
    body = { ...body, model: auth.defaultModel };
  }

  // Aliases rewrite one name; rules replace the request with a fallback chain.
  // Both are read from the same settings snapshot so a save between the two
  // lookups cannot make them disagree.
  const routing = getRoutingRules();
  const alias = resolveAlias(routing, body?.model);
  if (alias) {
    trace.route = 'alias';
    trace.via = alias.name;
    body = { ...body, model: alias.target };
  }

  const rule = matchRoutingRule(routing, body, req, auth);
  if (rule) {
    trace.route = 'rule';
    trace.via = rule.name;
    return handleModelChain(req, res, settings, auth, {
      chain: rule.chain,
      failureLabel: `Routing rule "${rule.name}"`,
      errorFields: { rule: rule.name },
      body,
      started,
      liveId,
      trace,
    });
  }

  // A combo name is checked before model resolution and is never a combo when it
  // contains "/". Array order is the fallback priority.
  const combo = comboModels(body.model);
  if (Array.isArray(combo) && combo.length) {
    const comboName = String(body.model).trim();
    // An alias that resolved to this combo stays the stated reason.
    if (trace.route === 'direct') {
      trace.route = 'combo';
      trace.via = comboName;
    }
    return handleModelChain(req, res, settings, auth, {
      chain: combo,
      failureLabel: `Combo "${comboName}"`,
      errorFields: { combo: comboName },
      body,
      started,
      liveId,
      trace,
    });
  }

  return handleSingleChat(req, res, settings, auth, { body, started, modelName: body.model, liveId, trace });
}

// Antigravity wraps each request in the Cloud Code envelope, which pins the
// account's project id and session id. Rebuild it per credential so pool
// rotation never sends one account's project with another account's token.
function antigravityBody(provider, body, model, row) {
  return toAntigravityRequest(
    { ...body, model: upstreamModelFor(provider, model) },
    { projectId: row?.project_id || '', sessionSeed: row?.id || `${provider.id}:${model}` },
  );
}

// One model, end to end. Returns a plain result object instead of always writing
// to `res`, so the chain loop can decide whether to fall through to the next
// model. `res` is only touched once the outcome is known.
async function handleSingleChat(req, res, settings, auth, { body, started, modelName, deferHeaders = false, chained = false, liveId = null, trace = null }) {
  // Every target the relay actually reaches is appended here, so a failed chain
  // reports the same walk the client saw in the error message.
  if (trace && modelName) trace.attempted.push(String(modelName));
  const resolved = resolveModel(modelName);
  if (resolved.error) {
    noteError(resolved.error, { trace });
    publishLive({ phase: 'error', id: liveId, at: Date.now(), model: modelName || null, status: 400, stage: 'model' });
    // A single-model request owns the response; only a combo attempt defers it.
    if (!deferHeaders) sendError(res, 400, resolved.error);
    return { ok: false, status: 400, message: resolved.error, model: null, fallback: false };
  }
  const { provider, model } = resolved;

  // A capped provider is a fallback condition, not a client error: a combo or
  // rule chain can still reach its next target. Only the last attempt surfaces
  // the 429 budget body.
  const providerBudget = budgetGate(`provider:${provider.id}`);
  if (providerBudget) {
    const message = budgetMessage(providerBudget, provider.id);
    noteError(message, { provider: provider.id, status: 429, activityModel: model, trace });
    publishLive({
      phase: 'error',
      id: liveId,
      at: Date.now(),
      provider: provider.id,
      model,
      status: 429,
      stage: 'budget',
    });
    if (!deferHeaders) sendJson(res, 429, budgetErrorBody(providerBudget, message));
    return { ok: false, status: 429, message, model, fallback: true };
  }

  const credential = await resolveCredential(provider);
  publishLive({
    phase: 'route',
    id: liveId,
    at: Date.now(),
    provider: provider.id,
    model,
    attempt: 1,
  });
  const wantsStream = body.stream === true;
  const { format: wireFormat, url: wireUrl } = wireFor(provider, credential.row, { stream: wantsStream });
  if (!credential.token && !credential.open) {
    const message = credential.pooled
      ? `Every account for ${provider.id} is cooling down or out of tokens. Add an account or wait for the cooldown.`
      : `No account credential for ${provider.id}. Add an account on the provider page.`;
    // No upstream call happened, so this error belongs to the provider, not to a
    // model row in the usage breakdown.
    const status = credential.pooled ? 429 : 401;
    noteError(message, { provider: provider.id, status, activityModel: model, trace });
    publishLive({
      phase: 'error',
      id: liveId,
      at: Date.now(),
      provider: provider.id,
      model,
      status,
      stage: 'credential',
    });
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

  let transformedBody;
  try {
    transformedBody = mapReasoning(provider, body);
  } catch (err) {
    publishLive({
      phase: 'error',
      id: liveId,
      at: Date.now(),
      provider: provider.id,
      model,
      status: err.status || 400,
      stage: 'model',
    });
    if (!deferHeaders) sendError(res, err.status || 400, err.message);
    return { ok: false, status: err.status || 400, message: err.message, model, fallback: false };
  }
  transformedBody = stripHistoryReasoning(transformedBody);
  transformedBody = applyTokenSaver(transformedBody, getTokenSaverSettings());
  transformedBody = applyReplyFilters(transformedBody, getReplyFiltersSettings());
  let upstreamBody = { ...transformedBody, model };
  if (wireFormat === 'responses' || wireFormat === 'anthropic' || wireFormat === 'antigravity') {
    try {
      if (wireFormat === 'responses') upstreamBody = toResponsesRequest({ ...transformedBody, model });
      else if (wireFormat === 'anthropic') upstreamBody = toAnthropicRequest({ ...transformedBody, model });
      else upstreamBody = antigravityBody(provider, transformedBody, model, credential.row);
    } catch (err) {
      publishLive({
        phase: 'error',
        id: liveId,
        at: Date.now(),
        provider: provider.id,
        model,
        status: err.status || 400,
        stage: 'model',
      });
      if (!deferHeaders) sendError(res, err.status || 400, err.message);
      return { ok: false, status: err.status || 400, message: err.message, model, fallback: false };
    }
  }

  // The upstream only answers on a stream, so non-streaming clients get the
  // SSE buffered here and collapsed into one completion.
  if (provider.forceStream) upstreamBody.stream = true;
  // include_usage only means anything when the upstream is actually streaming;
  // adding it to a non-streamed body is a spec violation some gateways reject.
  if (provider.forceStream && !wantsStream && wireFormat === 'openai') {
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
      headers: buildHeaders(provider, token, wireFormat),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  const payloadFor = (row, base = upstreamBody) => (wireFormat === 'antigravity'
    ? antigravityBody(provider, transformedBody, model, row)
    : base);

  // Declared outside the try so the catch block can still name the account it
  // was talking to; a `let` inside the try would be out of scope there.
  let attempt = credential;

  try {
    let upstream = null;
    let failure = null;

    // Inside a fallback chain, account rotation stays out of the way: one model
    // gets one credential attempt, then the chain moves to the next model.
    // Rotating every account onto the same failing model would park the whole
    // pool before the fallback ever runs.
    const maxRounds = chained ? 1 : MAX_ATTEMPTS;

    for (let round = 0; round < (chained ? maxRounds : accountAttemptLimit(provider.id)); round += 1) {
      if (round > 0) {
        attempt = await resolveCredential(provider);
        if (!attempt.token) break;
        // A rotated account is a new route on the map, not a new request.
        publishLive({
          phase: 'route',
          id: liveId,
          at: Date.now(),
          provider: provider.id,
          model,
          attempt: round + 1,
        });
      }

      let response;
      try {
        response = await callUpstream(payloadFor(attempt.row), attempt.token);
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
          response = await callUpstream(payloadFor(attempt.row, retryBody), attempt.token);
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
          const retry = await callUpstream(payloadFor(attempt.row), fresh.accessToken);
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
        noteError(message, { provider: provider.id, model, status: 429, trace });
        publishLive({
          phase: 'error',
          id: liveId,
          at: Date.now(),
          provider: provider.id,
          model,
          status: 429,
          stage: 'credential',
        });
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
        publishLive({
          phase: 'error',
          id: liveId,
          at: Date.now(),
          provider: provider.id,
          model,
          status: failure.status,
          stage: 'upstream',
        });
        return {
          ok: false,
          status: failure.status,
          message: firstMessage(failure.text),
          model,
          provider: provider.id,
          fallback: isFallbackStatus(failure.status),
        };
      }
      publishLive({
        phase: 'error',
        id: liveId,
        at: Date.now(),
        provider: provider.id,
        model,
        status: failure.status,
        stage: 'upstream',
      });
      relayFailure(res, failure.status, failure.text, provider, model, attempt.row?.label || '', trace);
      return { ok: false, status: failure.status, message: firstMessage(failure.text), model, fallback: isFallbackStatus(failure.status) };
    }

    // The upstream accepted the request; the lane can pulse before the body
    // finishes so long streams still show where they are.
    publishLive({
      phase: 'first',
      id: liveId,
      at: Date.now(),
      provider: provider.id,
      model,
      status: upstream.status || 200,
    });

    const accountId = attempt.row?.id || null;
    const contentType = upstream.headers.get('content-type') || '';
    const nativeRecovery = wireFormat === 'openai' && Array.isArray(body.tools) && body.tools.length > 0;

    if (!wantsStream && !contentType.includes('text/event-stream')) {
      // Upstream answered with a plain JSON body; normalize the reasoning alias
      // before relaying it.
      const text = await upstream.text();
      let payload;
      if (wireFormat === 'responses' && /^\s*(?:event|data):/m.test(text)) {
        // Some Responses upstreams stream despite a JSON (or missing)
        // content-type. Parse the body instead of wrapping raw SSE as an error.
        const acc = createAccumulator();
        for (const line of text.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            feedResponsesEvent(acc, JSON.parse(data));
          } catch {
            // Ignore malformed metadata frames.
          }
        }
        if (acc.state.error) {
          const message = acc.state.error.message || 'Upstream reported an error';
          noteError(message, { upstream: true, model, provider: provider.id, account: attempt.row?.label || '', status: 502, trace });
          publishLive({
            phase: 'error',
            id: liveId,
            at: Date.now(),
            provider: provider.id,
            model,
            status: 502,
            stage: 'upstream',
          });
          if (!deferHeaders) sendError(res, 502, message, { upstream: acc.state.error });
          return { ok: false, status: 502, message, model, provider: provider.id, fallback: true };
        }
        if (!acc.isTerminal()) {
          const message = `Upstream stream ended before completion (${provider.id}/${model}).`;
          noteError(message, { upstream: true, model, provider: provider.id, account: attempt.row?.label || '', status: 502, trace });
          publishLive({
            phase: 'error',
            id: liveId,
            at: Date.now(),
            provider: provider.id,
            model,
            status: 502,
            stage: 'upstream',
          });
          if (!deferHeaders) sendError(res, 502, message);
          return { ok: false, status: 502, message, model, provider: provider.id, fallback: true };
        }
        payload = acc.toCompletion(model);
      } else {
        try {
          payload = JSON.parse(text);
          if (wireFormat === 'responses') payload = fromResponsesResponse(payload);
          else if (wireFormat === 'anthropic') payload = fromAnthropicResponse(payload);
          else if (wireFormat === 'antigravity') payload = fromAntigravityResponse(payload);
          else {
            mirrorReasoningAlias(payload);
            recoverNativeToolCalls(payload, body.tools);
          }
        } catch (err) {
          // A translator rejection carries the upstream's own message; a plain
          // JSON parse failure can only fall back to the raw body.
          const message = err?.name === 'AntigravityFormatError' ? err.message : text;
          payload = { error: { message: message || 'Empty upstream response' } };
        }
      }
      // A 200 body can still be an upstream error envelope (or a parse failure
      // wrapped above). Relaying it as success would record an empty, failed
      // turn as a healthy request.
      if (payload?.error) {
        const message = typeof payload.error === 'string'
          ? payload.error
          : payload.error?.message || 'Upstream reported an error';
        noteError(message, { upstream: true, model, provider: provider.id, account: attempt.row?.label || '', status: 502, trace });
        publishLive({
          phase: 'error',
          id: liveId,
          at: Date.now(),
          provider: provider.id,
          model,
          status: 502,
          stage: 'upstream',
        });
        if (!deferHeaders) sendError(res, 502, message, { upstream: payload.error });
        return { ok: false, status: 502, message, model, provider: provider.id, fallback: true };
      }
      const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
      if (choice) {
        noteCompletionHealth({
          provider,
          model,
          content: choice.message?.content,
          toolCalls: choice.message?.tool_calls?.length || 0,
          reasoning: choice.message?.reasoning_content,
          recovery: nativeRecovery,
        });
      }
      const usage = payload.usage;
      noteRequest({
        provider: provider.id,
        model,
        usage,
        ms: Date.now() - started,
        account: attempt.row?.label || '',
        trace,
        keyId: auth.managedId,
      });
      const tool = Array.isArray(payload?.choices)
        && payload.choices.some((choice) => (choice?.message?.tool_calls?.length || 0) > 0);
      publishFinish({ liveId, provider: provider.id, model, usage, ms: Date.now() - started, tool });
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
      // Tools are known only on the request, so opt the relay into native
      // token recovery here; without declared tools a leaked block stays text.
      if (nativeRecovery) acc.nativeToolStream = createNativeToolStream(body.tools);
      const translator = wireFormat === 'anthropic'
        ? createAnthropicStream()
        : wireFormat === 'antigravity' ? createAntigravityStream() : null;
      activeId = beginActiveRequest({
        provider: provider.id,
        model,
        account: attempt.row?.label || '',
      });
      for await (const chunk of upstream.body) {
        if (wireFormat === 'responses') tapResponsesSSE(chunk, res, acc, decoder, bufferRef);
        else if (translator) tapTranslatedSSE(chunk, res, acc, decoder, bufferRef, translator);
        else tapSSE(chunk, res, acc, decoder, bufferRef);
        if (acc.state.usage) {
          updateActiveRequest(activeId, {
            tokensIn: acc.state.usage.prompt_tokens || 0,
            tokensOut: acc.state.usage.completion_tokens || 0,
          });
        }
      }
      if (wireFormat === 'openai') {
        flushSSE(res, acc, decoder, bufferRef);
      } else if (wireFormat === 'responses') {
        flushResponsesSSE(res, acc, decoder, bufferRef);
      } else {
        flushTranslatedSSE(res, acc, decoder, bufferRef, translator);
      }

      // Headers are gone, so this turn owns the response: a stream that ended
      // without a finish signal (or carried an error frame) is reported as an
      // error instead of a fake [DONE] and a successful empty completion.
      const failureCode = acc.state.error ? 'stream_error' : !acc.isTerminal() ? 'stream_truncated' : null;
      if (failureCode) {
        return failStreamedTurn(res, acc, {
          code: failureCode,
          provider,
          model,
          account: attempt.row?.label || '',
          liveId,
          trace,
        });
      }

      // Only emits when the upstream never sent a finish frame; a normal
      // stream already flushed every state when finish_reason arrived.
      if (wireFormat === 'openai') {
        for (const frame of acc.nativeToolStream?.finish() || []) {
          const chunk = {
            id: acc.state.id,
            object: 'chat.completion.chunk',
            created: acc.state.created || Math.floor(Date.now() / 1000),
            model: acc.state.model || model,
            choices: [frame],
          };
          acc.feed(chunk);
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
      }
      noteCompletionHealth({
        provider,
        model,
        content: acc.state.content,
        toolCalls: acc.state.toolCalls.length,
        reasoning: acc.state.reasoning,
        stream: true,
        recovery: nativeRecovery,
      });
      res.write('data: [DONE]\n\n');
      res.end();
      noteRequest({
        provider: provider.id,
        model,
        usage: acc.state.usage,
        ms: Date.now() - started,
        account: attempt.row?.label || '',
        trace,
        keyId: auth.managedId,
      });
      publishFinish({
        liveId,
        provider: provider.id,
        model,
        usage: acc.state.usage,
        ms: Date.now() - started,
        tool: acc.state.toolCalls.length > 0,
        stream: true,
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
    if (nativeRecovery) acc.nativeToolStream = createNativeToolStream(body.tools);
    activeId = beginActiveRequest({
      provider: provider.id,
      model,
      account: attempt.row?.label || '',
    });
    const translator = wireFormat === 'anthropic'
      ? createAnthropicStream()
      : wireFormat === 'antigravity' ? createAntigravityStream() : null;
    for await (const event of readSSEEvents(upstream.body, acc.state)) {
      if (wireFormat === 'responses') {
        // Responses events are not chat chunks; translate each one before
        // accumulating or the raw SSE text ends up wrapped as an error.
        feedResponsesEvent(acc, event.data);
      } else if (translator) {
        for (const frame of translator.push(event.data)) acc.feed(frame);
      } else {
        if (acc.nativeToolStream) acc.nativeToolStream.apply(event.data);
        acc.feed(event.data);
      }
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
      noteError(message, { upstream: true, model, provider: provider.id, account: attempt.row?.label || '', status: 502, trace });
      publishLive({
        phase: 'error',
        id: liveId,
        at: Date.now(),
        provider: provider.id,
        model,
        status: 502,
        stage: 'upstream',
      });
      if (!deferHeaders) sendError(res, 502, message, { upstream: acc.state.error });
      // An in-stream error frame has no HTTP status to key off; treat it as a
      // target failure so a combo can try the next model.
      return { ok: false, status: 502, message, model, provider: provider.id, fallback: true };
    }

    // Nothing was written yet, so a stream that stopped before any finish
    // signal is a target failure the chain may retry on another model.
    if (!acc.state.done && acc.state.finishReason === null) {
      const message = `Upstream stream ended before completion (${provider.id}/${model}).`;
      noteError(message, { upstream: true, model, provider: provider.id, account: attempt.row?.label || '', status: 502, trace });
      publishLive({
        phase: 'error',
        id: liveId,
        at: Date.now(),
        provider: provider.id,
        model,
        status: 502,
        stage: 'upstream',
      });
      if (!deferHeaders) sendError(res, 502, message);
      return { ok: false, status: 502, message, model, provider: provider.id, fallback: true };
    }

    // Only after the stream proved terminal may recovery flush what it
    // buffered: a synthetic finish frame would otherwise turn a cut stream
    // into a successful completion.
    for (const frame of acc.nativeToolStream?.finish() || []) acc.feed({ choices: [frame] });

    const completion = acc.toCompletion(model);
    noteCompletionHealth({
      provider,
      model,
      content: acc.state.content,
      toolCalls: acc.state.toolCalls.length,
      reasoning: acc.state.reasoning,
      recovery: nativeRecovery,
    });
    noteRequest({
      provider: provider.id,
      model,
      usage: acc.state.usage,
      ms: Date.now() - started,
      account: attempt.row?.label || '',
      trace,
      keyId: auth.managedId,
    });
    publishFinish({
      liveId,
      provider: provider.id,
      model,
      usage: acc.state.usage,
      ms: Date.now() - started,
      tool: acc.state.toolCalls.length > 0,
    });
    recordApiKeyTokens(auth.managedId, acc.state.usage);
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
        trace,
      });
      publishLive({
        phase: 'error',
        id: liveId,
        at: Date.now(),
        provider: provider.id,
        model,
        status: 499,
        stage: clientGone ? 'client' : 'upstream',
      });
      if (!res.headersSent) {
        if (deferHeaders) return { ok: false, status: 499, message: 'Request aborted', model, fallback: false, aborted: true };
        sendError(res, 499, 'Request aborted');
      } else {
        // The client is gone on disconnect, so only a timeout can be reported.
        if (!clientGone) writeStreamErrorFrame(res, 'stream_timeout', 'Upstream timed out');
        else res.end();
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
      trace,
    });
    publishLive({
      phase: 'error',
      id: liveId,
      at: Date.now(),
      provider: provider.id,
      model,
      status: 502,
      stage: 'upstream',
    });
    if (!res.headersSent) {
      if (deferHeaders) return { ok: false, status: 502, message: err.message, model, provider: provider.id, fallback: true };
      sendError(res, 502, `Upstream request failed: ${err.message}`);
      return { ok: false, status: 502, message: err.message, model, provider: provider.id, fallback: true };
    }
    // Mid-stream failure: headers are gone, so report it in the stream instead
    // of a bare close. A chain retry would append a second model's bytes to a
    // response that already started, so the failure stays here.
    writeStreamErrorFrame(res, 'stream_error', `Upstream request failed: ${err.message}`);
    return { ok: false, status: 502, message: err.message, model, provider: provider.id, fallback: false };
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

// Responses events carry the text under `type`/`delta`, not `choices`; map them
// before they reach an OpenAI accumulator.
function feedResponsesEvent(acc, data) {
  acc.responsesStream ||= createResponsesStreamState();
  if (data?.type === 'response.incomplete') acc.markDone();
  const mapped = fromResponsesStream(data, acc.responsesStream);
  if (mapped.kind === 'delta' || mapped.kind === 'tool_delta' || mapped.kind === 'complete' || mapped.kind === 'error') {
    acc.feed(mapped.frame);
  }
}

// A fallback chain (combo or vision routing) tries each real model in order.
// Only failures that describe the target (401/402/403/404/429/5xx) move to the
// next one; a request-shaped 400 stops immediately so the same bad request is
// not billed to every model. Nothing is written to `res` until a model succeeds,
// so streaming clients never see bytes from a model that was abandoned.
async function handleModelChain(req, res, settings, auth, { chain, failureLabel, errorFields = {}, body, started, liveId = null, trace = null }) {
  const attempts = [];
  let firstFallbackFailure = null;
  let lastFailure = null;

  for (const modelName of chain) {
    // A streamed attempt owns the response once its headers leave; never append
    // another model's bytes behind a response that has already started.
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return undefined;
    }
    const result = await handleSingleChat(req, res, settings, auth, {
      body,
      started,
      modelName,
      deferHeaders: true,
      chained: true,
      liveId,
      trace,
    });
    if (result.ok) {
      // The winning attempt returned instead of writing, so the chain loop is
      // responsible for the single response the client receives.
      if (result.streamed) return undefined; // headers and body already sent
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return undefined;
      }
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
    || { status: 502, message: 'No chain model could serve this request.' };
  const message = `${failureLabel} failed. Tried: ${attempts.join(' → ')}. ${primary.message}`;
  noteError(message, { upstream: true, model: null, trace });
  // Relay the upstream status itself (a request-shaped 400 stays 400), and only
  // promote to upstream_error when the failure really came from the server.
  const status = primary.status >= 400 && primary.status < 600 ? primary.status : 502;
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return undefined;
  }
  sendJson(res, status, {
    error: {
      message,
      type: status >= 500 ? 'upstream_error' : 'invalid_request_error',
      ...errorFields,
      attempted: attempts,
    },
  });
  return undefined;
}
