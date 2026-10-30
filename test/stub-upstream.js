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

  if (!/^Bearer \S+/.test(req.headers.authorization || '')) {
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'stub: bad credential' } }));
  }

  const token = req.headers.authorization.slice(7).trim();
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
    // A 400 whose body carries no OpenAI-shaped message, so the tester can be
    // proven to surface the raw upstream text instead of a generic fallback.
    if (body.model === 'gpt-weird-error') {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ detail: [{ type: 'missing', loc: ['body', 'store'], msg: 'Field required' }] }));
    }
    return responsesSse(res, body.model, `I am the ${body.model} Codex model.`);
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
