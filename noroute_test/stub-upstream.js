// Stand-in for copilot.tencent.com used to exercise the proxy end to end
// without a real credential. Streams [OI]-style SSE like the real gateway, and
// mirrors the refresh/quota endpoints so the account pool can be tested.
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const QUOTA_PAYLOAD = {
  code: 0,
  data: {
    Response: {
      Data: {
        Accounts: [
          {
            PackageName: 'CodeBuddy Pro',
            SubProductName: 'CodeBuddy',
            CycleStartTime: '2026-10-01T00:00:00+08:00',
            CycleEndTime: '2026-11-01T00:00:00+08:00',
            DeductionEndTime: '2027-11-01T00:00:00+08:00',
            CycleCapacityUsedPrecise: '120',
            CycleCapacitySizePrecise: '500',
            CapacityUsed: 0,
            CapacitySize: 0,
          },
        ],
      },
    },
  },
};

// Quota fixtures with different headroom, so the highest-quota strategy can be
// proven to pick by remaining capacity instead of pool order.
const QUOTA_CAPACITY = {
  'low-quota-token': { used: '400', size: '500' },
  'high-quota-token': { used: '10', size: '5000' },
  'full-quota-token': { used: '500', size: '500' },
};

function quotaPayload(token) {
  const capacity = QUOTA_CAPACITY[token];
  if (!capacity) return QUOTA_PAYLOAD;
  const payload = structuredClone(QUOTA_PAYLOAD);
  const account = payload.data.Response.Data.Accounts[0];
  account.CycleCapacityUsedPrecise = capacity.used;
  account.CycleCapacitySizePrecise = capacity.size;
  return payload;
}

function sse(res, model, text, { fail = false } = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const id = `chatcmpl-stub-${Date.now()}`;
  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  if (fail) {
    res.write('data: {"error":{"message":"stub quota exhausted","type":"rate_limit"}}\n\n');
    return res.end();
  }

  send({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });

  const words = text.split(' ');
  let i = 0;
  const timer = setInterval(() => {
    if (i >= words.length) {
      clearInterval(timer);
      send({ id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      send({ id, choices: [], usage: { prompt_tokens: 42 + i, completion_tokens: i * 3, total_tokens: 42 + i * 4 } });
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    send({ id, choices: [{ index: 0, delta: { content: (i ? ' ' : '') + words[i] } }] });
    i += 1;
  }, 25);
}

// Anthropic Messages fixtures. The body checks are deliberately strict: a
// request that skipped the Anthropic translation still carries `messages` with
// a system role, `max_tokens` missing, or OpenAI-only fields, and must fail.
function anthropicReject(res, message) {
  res.writeHead(400, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }));
}

function anthropicJson(res, model, text, { tool = null, thinking = '' } = {}) {
  const content = [];
  if (thinking) content.push({ type: 'thinking', thinking, signature: '' });
  if (tool) content.push({ type: 'tool_use', id: 'toolu_stub', name: tool.name, input: tool.input });
  else content.push({ type: 'text', text });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: `msg_stub_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: tool ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 9, output_tokens: 5 },
  }));
}

function anthropicSse(res, model, text, { tool = null, thinking = '', truncate = false } = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const send = (type, payload) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
  const id = `msg_stub_${Date.now()}`;
  send('message_start', {
    message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 9, output_tokens: 0 } },
  });

  let index = 0;
  if (thinking) {
    send('content_block_start', { index, content_block: { type: 'thinking', thinking: '' } });
    for (const part of thinking.split(' ')) send('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: `${part} ` } });
    send('content_block_stop', { index });
    index += 1;
  }
  if (tool) {
    const json = JSON.stringify(tool.input);
    const split = Math.ceil(json.length / 2);
    send('content_block_start', { index, content_block: { type: 'tool_use', id: 'toolu_stub', name: tool.name, input: {} } });
    send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: json.slice(0, split) } });
    send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: json.slice(split) } });
    send('content_block_stop', { index });
  } else {
    send('content_block_start', { index, content_block: { type: 'text', text: '' } });
    for (const word of text.split(' ')) send('content_block_delta', { index, delta: { type: 'text_delta', text: `${word} ` } });
    send('content_block_stop', { index });
  }
  // A connection cut before message_delta/message_stop: the client must see an
  // error frame, never a finished message assembled from a partial answer.
  if (truncate) return res.end();
  send('message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 7 } });
  send('message_stop', {});
  res.end();
}

function anthropicFixture(model) {
  if (model === 'anthropic-tool') return { tool: { name: 'get_weather', input: { city: 'Jakarta', unit: 'celsius' } } };
  if (model === 'anthropic-thinking') return { thinking: 'Let me think about it.' };
  return null;
}

// Codex Responses stream fixture. Accepts `{input}` and rejects a Chat
// Completions `{messages}` body, so a wrongly translated probe fails loudly
// instead of silently returning nothing.
function responsesSse(res, model, text) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const id = `resp-stub-${Date.now()}`;
  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  for (const word of text.split(' ')) {
    send({ type: 'response.output_text.delta', response_id: id, item_id: 'item-0', delta: `${word} ` });
  }
  send({
    type: 'response.completed',
    response: { id, model, output: [{ type: 'message', content: [{ type: 'output_text', text }] }] },
    usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
  });
  res.end();
}

let issued = 0;
// Every chat call the stub served, in order, so tests can prove which models a
// combo actually reached.
export const calls = [];
export const chatBodies = [];
export const responsesBodies = [];
export const anthropicBodies = [];
export const antigravityBodies = [];
export const antigravityQuotaCalls = [];
export const quotaCalls = [];

// Every request that reached the Responses route with the wrong body shape, so
// tests can prove the translation happened before the probe was sent.
export const probeShapes = [];

const handler = async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body = {};
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}

  // ---- refresh endpoint (no Authorization header) ----
  if (req.url.includes('/plugin/auth/token/refresh')) {
    const refresh = req.headers['x-refresh-token'];
    if (!refresh) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 1, msg: 'missing refresh token' }));
    }
    if (refresh === 'refresh-dead') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 11217, msg: 'refresh token expired' }));
    }
    issued += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      code: 0,
      data: { accessToken: `fresh-access-${issued}`, refreshToken: refresh, expiresIn: 3600 },
    }));
  }

  // ---- daily check-in endpoint (OAuth bearer + user ID required) ----
  if (req.url.includes('/billing/meter/daily-checkin')) {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const valid = token && req.headers['x-user-id'] && req.headers['x-domain'] === 'www.codebuddy.cn'
      && req.headers['x-codebuddy-request'] === '1' && JSON.stringify(body) === '{}';
    if (!valid) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 400, msg: 'stub: invalid daily check-in request' }));
    }
    if (token === 'already-token') {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 10001, msg: 'already checked in' }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (token === 'inactive-token') return res.end(JSON.stringify({ code: 1003, msg: 'activity inactive' }));
    return res.end(JSON.stringify({ code: 0, msg: 'daily check-in successful' }));
  }

  // ---- Codex WHAM quota endpoint (Bearer required) ----
  if (req.url.includes('/wham/usage')) {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'stub: missing credential' } }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      plan_type: token === 'codex-pro-quota-token' ? 'pro' : 'free',
      rate_limit: {
        primary_window: { used_percent: token === 'codex-exhausted-quota-token' ? 100 : token === 'codex-pro-quota-token' ? 18 : 92, reset_at: 1_800_000_000 },
        secondary_window: { used_percent: 42, reset_at: 1_801_000_000 },
      },
    }));
  }

  // ---- quota endpoint (Bearer required) ----
  if (req.url.includes('/billing/meter/get-user-resource')) {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    quotaCalls.push(token);
    if (!token || token === 'bad-token' || token === 'limited-token') {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 401, msg: 'stub: bad credential' }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (token === 'empty-quota-token') {
      return res.end(JSON.stringify({ code: 0, data: { Response: { Data: { Accounts: [] } } } }));
    }
    return res.end(JSON.stringify(quotaPayload(token)));
  }

  // Anthropic clients authenticate with x-api-key instead of a bearer token.
  const bearer = /^Bearer \S+/.test(req.headers.authorization || '');
  const apiKey = typeof req.headers['x-api-key'] === 'string' && req.headers['x-api-key'].trim();
  if (!bearer && !apiKey) {
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'stub: bad credential' } }));
  }

  const token = bearer ? req.headers.authorization.slice(7).trim() : String(req.headers['x-api-key']).trim();

  // ---- embeddings (CodeBuddy /v2/embeddings) ----
  if (req.url.endsWith('/embeddings')) {
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    if (!inputs.length || inputs.some((input) => typeof input !== 'string' || !input)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 400, msg: 'stub: invalid input' }));
    }
    if (body.model !== 'hunyuan-embedding' && body.model !== 'bge-m3') {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 11102, msg: 'stub: model service info not found' }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      object: 'list',
      data: inputs.map((input, index) => ({ object: 'embedding', index, embedding: [input.length, index + 0.25] })),
      model: body.model,
      usage: { prompt_tokens: inputs.reduce((sum, input) => sum + input.length, 0), total_tokens: inputs.reduce((sum, input) => sum + input.length, 0) },
    }));
  }

  // ---- image generation (CodeBuddy /v2/images/generations) ----
  if (req.url.endsWith('/images/generations')) {
    if (!body.prompt) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 400, msg: 'stub: missing prompt' }));
    }
    if (body.model === 'hunyuan-image-alpha') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        code: 0,
        data: { created: 1_800_000_000, data: [{ url: 'https://stub.invalid/img.png' }], usage: { image_generation_count: 1 } },
      }));
    }
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ code: 11102, msg: 'stub: model service info not found' }));
  }

  if (token === 'bad-token') {
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'stub: revoked credential' } }));
  }
  if (token === 'limited-token' || token.startsWith('limited-token-')) {
    res.writeHead(429, {
      'content-type': 'application/json',
      'retry-after': '1',
    });
    return res.end(JSON.stringify({ error: { message: 'stub: rate limited' } }));
  }

  // ---- Antigravity Cloud Code quota routes (Bearer required) ----
  // The summary is the primary source; the model list only serves paid tiers
  // whose summary carries no shared pools.
  if (req.url.startsWith('/v1internal:loadCodeAssist')) {
    antigravityQuotaCalls.push({ path: 'loadCodeAssist', token, body });
    if (token === 'ag-quota-forbidden-token') {
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'stub: quota access forbidden' } }));
    }
    // Antigravity always reports `currentTier: free-tier`; the paid Google One
    // plan is what `paidTier` carries. A really free account gets the starter
    // quota in both fields.
    const paidTier = token === 'ag-paid-quota-token'
      ? { id: 'g1-pro-tier', name: 'Google AI Pro' }
      : token === 'ag-plus-quota-token'
        ? { id: 'g1-plus-tier', name: 'Google AI Plus' }
        : token === 'ag-ultra-quota-token'
          ? { id: 'g1-ultra-tier', name: 'Google AI Ultra' }
          : { id: 'free-tier', name: 'Antigravity Starter Quota' };
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      cloudaicompanionProject: 'stub-project',
      currentTier: { id: 'free-tier', name: 'Antigravity' },
      paidTier,
      allowedTiers: [{ id: 'free-tier' }, { id: 'standard-tier' }],
    }));
  }

  if (req.url.startsWith('/v1internal:retrieveUserQuotaSummary')) {
    antigravityQuotaCalls.push({ path: 'quotaSummary', token, body });
    if (token === 'ag-quota-forbidden-token') {
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'stub: quota access forbidden' } }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (token === 'ag-paid-quota-token' || token === 'ag-quota-blank-token') {
      return res.end(JSON.stringify({ groups: [] }));
    }
    return res.end(JSON.stringify({
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [{
            bucketId: 'gemini-weekly',
            displayName: 'Weekly Limit Remaining',
            window: 'weekly',
            resetTime: '2026-11-15T16:06:23Z',
            remainingFraction: 0.4,
          }],
        },
        {
          displayName: 'Claude and GPT models',
          buckets: [
            {
              bucketId: '3p-weekly',
              displayName: 'Weekly Limit Remaining',
              window: 'weekly',
              resetTime: '2026-11-16T00:57:45Z',
              remainingFraction: 0,
            },
            {
              bucketId: '3p-session',
              displayName: 'Five hour limit remaining',
              window: '5h',
              resetTime: '2026-11-12T20:00:00Z',
              remainingFraction: 0.9,
              disabled: true,
            },
          ],
        },
      ],
    }));
  }

  if (req.url.startsWith('/v1internal:fetchAvailableModels')) {
    antigravityQuotaCalls.push({ path: 'availableModels', token, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      models: {
        'gemini-3.8-flash-high': { displayName: 'Gemini 3.8 Flash (High)', quotaInfo: { remainingFraction: 0.2, resetTime: '2026-11-15T16:06:23Z' } },
        'claude-sonnet-4-6': { displayName: 'Claude Sonnet 4.6 (Thinking)', quotaInfo: { remainingFraction: 0.75, resetTime: '2026-11-16T00:57:45Z' } },
        'internal-model': { isInternal: true, quotaInfo: { remainingFraction: 1 } },
      },
    }));
  }

  // Antigravity Cloud Code route. The gateway expects the v1internal envelope,
  // so a request that skipped lib/antigravity-format.js has no `contents` and
  // is rejected instead of silently answered.
  if (req.url.startsWith('/v1internal:')) {
    const envelopeOk = typeof body.project === 'string' && body.project
      && typeof body.model === 'string' && body.model
      && body.userAgent === 'antigravity'
      && typeof body.requestId === 'string' && body.requestId.startsWith('agent/')
      && body.request && Array.isArray(body.request.contents) && body.request.contents.length
      && !('requestType' in body.request)
      && !('safetySettings' in body.request)
      && !('stream_options' in body.request);
    if (!envelopeOk) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'stub: invalid Antigravity envelope' } }));
    }
    calls.push(body.model);
    antigravityBodies.push(structuredClone(body));
    const usageMetadata = { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18 };
    const text = `I am the ${body.model} Antigravity model.`;
    if (req.url.includes(':streamGenerateContent')) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
      if (body.model === 'gemini-3.5-flash-lite') {
        // A candidate without finishReason followed by EOF must surface as an
        // error, not as a completed Antigravity answer.
        send({ response: { responseId: 'ag-stub-cut', modelVersion: body.model, candidates: [{ content: { parts: [{ text: 'half an ans' }] } }] } });
        return res.end();
      }
      send({ response: { responseId: 'ag-stub-stream', modelVersion: body.model, candidates: [{ content: { parts: [{ text: 'I am the ' }] } }] } });
      send({ response: { responseId: 'ag-stub-stream', modelVersion: body.model, candidates: [{ content: { parts: [{ text: `${body.model} Antigravity model.` }] }, finishReason: 'STOP' }], usageMetadata } });
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      response: {
        responseId: 'ag-stub-response',
        modelVersion: body.model,
        candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
        usageMetadata,
      },
    }));
  }

  // Codex catalog endpoint fixture; uses a different response envelope.
  if (req.url.startsWith('/v2/codex/models')) {
    if (!new URL(req.url, 'http://stub').searchParams.get('client_version')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'client_version required' } }));
    }
    const models = token === 'codex-free-catalog-token'
      ? [{ slug: 'gpt-stub-free' }, { model: 'gpt-stub-shared' }]
      : token === 'codex-plus-catalog-token'
        ? [{ slug: 'gpt-stub-plus' }, { model: 'gpt-stub-shared' }]
        : [{ slug: 'gpt-stub-codex' }, { model: 'gpt-stub-fast' }];
    const plan_type = token === 'codex-free-catalog-token' ? 'free' : token === 'codex-plus-catalog-token' ? 'plus' : 'pro';
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ plan_type, items: models }));
  }

  // Catalog endpoint, so "Fetch from provider" can be exercised end to end.
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: 'glm-5.3', object: 'model' },
        { id: 'stub-only-model', object: 'model' },
        { id: 'stub-second-model', object: 'model' },
      ],
    }));
  }

  // Codex Responses route. A probe that skipped the Responses translation would
  // arrive with `messages`, which real Codex rejects with 400.
  if (req.url.startsWith('/v2/codex/responses')) {
    calls.push(body.model);
    if (body.messages || !body.input || body.store !== false) {
      probeShapes.push({ url: req.url, hasMessages: Boolean(body.messages), hasInput: Boolean(body.input) });
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: "stub: Responses body requires input and store=false", type: 'invalid_request_error' } }));
    }
    responsesBodies.push(structuredClone(body));
    // A 400 whose body carries no OpenAI-shaped message, so the tester can be
    // proven to surface the raw upstream text instead of a generic fallback.
    if (body.model === 'gpt-weird-error') {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ detail: [{ type: 'missing', loc: ['body', 'store'], msg: 'Field required' }] }));
    }
    return responsesSse(res, body.model, `I am the ${body.model} Codex model.`);
  }

  // Generic Anthropic Messages route for custom providers.
  if (req.url.endsWith('/messages')) {
    calls.push(body.model);
    const blocksOk = Array.isArray(body.messages) && body.messages.length > 0
      && body.messages.every((message) => ['user', 'assistant'].includes(message.role) && Array.isArray(message.content));
    const toolsOk = body.tools === undefined
      || (Array.isArray(body.tools) && body.tools.every((tool) => tool.name && tool.input_schema && typeof tool.input_schema === 'object'));
    const cleanBody = !('reasoning_effort' in body) && !('stream_options' in body);
    if (!blocksOk || !toolsOk || !cleanBody || !Number.isInteger(body.max_tokens) || body.max_tokens <= 0
      || req.headers['anthropic-version'] !== '2023-06-01' || !req.headers['x-api-key']) {
      return anthropicReject(res, 'stub: invalid Messages request');
    }
    anthropicBodies.push(structuredClone(body));
    const fixture = anthropicFixture(body.model) || {};
    const text = `I am the ${body.model} model.`;
    if (body.stream !== true) return anthropicJson(res, body.model, text, fixture);
    return anthropicSse(res, body.model, text, { ...fixture, truncate: body.model === 'anthropic-truncated' });
  }

  // Generic OpenAI Responses route for custom providers. Rejects a raw chat
  // body so a missing translation cannot pass silently.
  if (req.url.endsWith('/responses')) {
    calls.push(body.model);
    if (body.messages || !Array.isArray(body.input) || body.store !== false) {
      probeShapes.push({ url: req.url, hasMessages: Boolean(body.messages), hasInput: Boolean(body.input) });
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'stub: Responses body requires input and store=false', type: 'invalid_request_error' } }));
    }
    responsesBodies.push(structuredClone(body));
    const text = `I am the ${body.model} Responses model.`;
    if (body.model === 'responses-truncated') {
      // Deltas then EOF, with no response.completed: a cut relay, not a finish.
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', response_id: 'resp_stub', item_id: 'item-0', delta: 'half an ans' })}\n\n`);
      return res.end();
    }
    if (body.model === 'responses-completed-no-newline') {
      // The terminal frame arrives without its blank line; the relay must close
      // it itself instead of merging it with the synthetic [DONE].
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', response_id: 'resp_stub', item_id: 'item-0', delta: text })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: 'response.completed',
        response: { id: 'resp_stub', model: body.model },
        usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
      })}`);
      return res.end();
    }
    if (body.model === 'responses-incomplete') {
      // A deliberate upstream ending (token cap): terminal, but no finish frame.
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', response_id: 'resp_stub', item_id: 'item-0', delta: text })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'response.incomplete', response: { id: 'resp_stub', model: body.model } })}\n\n`);
      return res.end();
    }
    if (body.model === 'responses-mislabeled') {
      // SSE body behind a JSON content-type; the router must detect the body
      // instead of trusting the header.
      res.writeHead(200, { 'content-type': 'application/json' });
      const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
      send({ type: 'response.output_text.delta', response_id: 'resp_stub', item_id: 'item-0', delta: text });
      send({
        type: 'response.completed',
        response: { id: 'resp_stub', model: body.model },
        usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
      });
      return res.end();
    }
    if (body.stream !== true) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        id: `resp_stub_${Date.now()}`,
        object: 'response',
        model: body.model,
        output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
        usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
      }));
    }
    return responsesSse(res, body.model, text);
  }

  if (!req.url.endsWith('/chat/completions')) {
    res.writeHead(404).end();
    return;
  }

  // Combo tests need models whose failure mode is deterministic and countable.
  // `combo-always-429` never succeeds; `combo-always-400` fails with a
  // request-shaped error that must NOT trigger a combo fallback.
  if (body.model === 'combo-always-429') {
    calls.push(body.model);
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
    return res.end(JSON.stringify({ error: { message: 'stub: combo model is rate limited', type: 'rate_limit' } }));
  }
  if (body.model === 'combo-always-400') {
    calls.push(body.model);
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'stub: context overflow (client bug)', type: 'invalid_request_error' } }));
  }

  calls.push(body.model);
  chatBodies.push(structuredClone(body));

  if (body.model === 'idle') {
    await new Promise((r) => setTimeout(r, 450));
  }

  // Echo the received reasoning fields so the smoke suite can assert what the
  // proxy actually forwards after its reasoning transform.
  if (body.model === 'echo-reasoning') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'echo' } }],
      echoed: {
        reasoning_effort: body.reasoning_effort ?? null,
        reasoning_summary: body.reasoning_summary ?? null,
        messages: body.messages || [],
        tools: body.tools ?? null,
      },
    }));
  }

  // CodeBuddy sends `"tool_calls": []` on ordinary reasoning and content
  // deltas; the proxy must not relay that empty array to the client.
  if (body.model === 'reasoning-empty-tools') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const id = `chatcmpl-stub-${Date.now()}`;
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    send({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '', tool_calls: [] } }] });
    for (const part of ['Think ', 'in ', 'one ', 'block.']) {
      send({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { reasoning_content: part, tool_calls: [] } }] });
    }
    send({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Done.', tool_calls: [] } }] });
    send({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_stub', type: 'function', function: { name: 'stub_tool', arguments: '{}' } }] } }] });
    send({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    send({ id, object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 } });
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  // Some gateways stream tool argument fragments before the function name.
  // Translators must buffer the early bytes instead of dropping them.
  if (body.model === 'tool-late-name') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const id = `chatcmpl-stub-late-${Date.now()}`;
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    send({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
    send({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_late', type: 'function', function: { arguments: '{"city":' } }] } }] });
    send({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Jakarta"' } }] } }] });
    send({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'get_weather' } }] } }] });
    send({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ',"unit":"celsius"}' } }] } }] });
    send({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    send({ id, object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 7, completion_tokens: 8, total_tokens: 15 } });
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  // Upstage-style upstreams stream chain of thought as `reasoning`, not
  // `reasoning_content`; the proxy must mirror it for canonical-only clients.
  if (body.model === 'reasoning-alias') {
    if (body.stream !== true) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'chatcmpl-stub-alias',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', reasoning: 'Alias thought.', content: 'Alias answer.' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      }));
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const id = `chatcmpl-stub-alias-${Date.now()}`;
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    send({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
    for (const part of ['Alias ', 'thought.']) {
      send({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { reasoning: part } }] });
    }
    send({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Alias answer.' } }] });
    send({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    send({ id, object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } });
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  // Upstage Solar sometimes leaks its native tool-call tokens into `content`
  // when its own parser misses the call; the proxy must recover the call.
  if (body.model === 'native-leak') {
    const leaked = '<|tool_callstart|>Read <|tool_orgstart|>file_path <|tool_argvalue|>F:\\Project\\app\\main.rs<|tool_argend|> <|tool_callend|>';
    if (body.stream !== true) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'chatcmpl-stub-leak',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: leaked }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 9, total_tokens: 12 },
      }));
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const id = `chatcmpl-stub-leak-${Date.now()}`;
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    send({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
    for (const part of ['Thinking.\n', '<|tool_call', 'start|>Read <|tool_orgstart|>file_path <|tool_argvalue|>F:\\Pro', 'ject\\app\\main.rs<|tool_argend|> <|tool_callend|>']) {
      send({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: part } }] });
    }
    send({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    send({ id, object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 3, completion_tokens: 9, total_tokens: 12 } });
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  // A connection cut mid-answer: content deltas, then EOF with no finish_reason
  // and no [DONE]. The relay must report a truncated stream, not success.
  if (body.model === 'truncated-openai') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const id = `chatcmpl-stub-cut-${Date.now()}`;
    res.write(`data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [{ index: 0, delta: { role: 'assistant', content: 'half an ans' } }],
    })}\n\n`);
    return res.end();
  }

  // The upstream finishes with a frame that lacks its trailing blank line and
  // closes immediately. A valid finish frame must still reach the client.
  if (body.model === 'truncated-final-frame') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const id = `chatcmpl-stub-final-${Date.now()}`;
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    send({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
    send({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'complete answer' } }] });
    res.write(`data: ${JSON.stringify({ id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}`);
    return res.end();
  }

  // HTTP 200 with an error envelope instead of a completion; relaying it as a
  // success would record a failed turn as a healthy request.
  if (body.model === 'json-error-body') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'stub: upstream refused the turn', type: 'server_error' } }));
  }

  const answer = body.messages?.[0]?.content === 'Hi, what your model AI ? and your training cut off ?'
    ? `I am the ${body.model} model. My training cutoff is a stub fixture date.`
    : `stub reply for ${body.model} with a few extra words`;
  sse(res, body.model, answer, {
    fail: body.model === 'glm-5.3-flash',
  });
};

export function createStubServer() {
  return http.createServer(handler);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const port = Number(process.argv[2] || 4599);
  createStubServer().listen(port, '127.0.0.1', () => {
    console.log(`stub upstream on ${port}`);
  });
}
