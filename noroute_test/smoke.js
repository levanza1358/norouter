import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Keep the test hermetic: a throwaway database, and no real credential. The
// chat path must fail before it ever reaches the network.
const TEST_DB_FILE = join(tmpdir(), `norouter-smoke-${process.pid}.db`);
process.env.NOROUTER_DB = TEST_DB_FILE;
delete process.env.CODEBUDDY_CN_TOKEN;
delete process.env.CODEBUDDY_CN_API_KEY;

const { createStubServer, calls: stubCalls, chatBodies, responsesBodies, anthropicBodies, antigravityBodies, antigravityQuotaCalls, probeShapes, quotaCalls } = await import('./stub-upstream.js');

const stub = createStubServer();
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const stubBase = `http://127.0.0.1:${stub.address().port}`;

// Point the shipped provider at the stub for chat, refresh and quota.
process.env.CODEBUDDY_CN_BASE_URL = `${stubBase}/v2`;
process.env.CODEBUDDY_CN_REFRESH_URL = `${stubBase}/v2/plugin/auth/token/refresh`;
process.env.CODEBUDDY_CN_QUOTA_URL = `${stubBase}/v2/billing/meter/get-user-resource`;
process.env.CODEBUDDY_CN_CHECKIN_URL = `${stubBase}/v2/billing/meter/daily-checkin`;
// The Antigravity envelope is translated locally; the base URL only has to
// reach the stub. OAuth credentials stay unset on purpose: the start route must
// fail closed instead of opening a browser flow in CI.
process.env.ANTIGRAVITY_BASE_URL = stubBase;
delete process.env.ANTIGRAVITY_CLIENT_ID;
delete process.env.ANTIGRAVITY_CLIENT_SECRET;

const { resolveModel } = await import('../noroute_src/lib/model.js');
const { providers } = await import('../noroute_src/providers/index.js');
const { createAccumulator, mirrorReasoningAlias, readSSEEvents } = await import('../noroute_src/lib/sse.js');
const {
  createNativeToolStream,
  parseNativeToolCalls,
  recoverNativeToolCalls,
} = await import('../noroute_src/lib/native-tool-calls.js');
const { parseCodebuddyQuota } = await import('../noroute_src/lib/codebuddy.js');
const { applyReplyFilters, buildInstruction } = await import('../noroute_src/lib/reply-filters.js');
const { createResponsesStreamState, fromResponsesStream, toResponsesRequest } = await import('../noroute_src/lib/responses-format.js');
const {
  bulkCreateAccounts,
  createAccount,
  deleteAccount,
  getAccount,
  getAccountRow,
  listAccounts,
  pickAccount,
  markFailure,
  normalizeAutoAccountLabels,
  previewAccounts,
} = await import('../noroute_src/lib/accounts.js');
const { ACCOUNT_PLANS, isKnownPlan, normalizePlan, planLabel } = await import('../noroute_src/lib/plan.js');
const { antigravityTier } = await import('../noroute_src/lib/antigravity-quota.js');
const { parseOAuthRedirect } = await import('../noroute_src/lib/oauth-callback.js');
const {
  startCodexOAuth,
  completeCodexOAuth,
  oauthStateStatus,
} = await import('../noroute_src/lib/codex-oauth.js');
const {
  startAntigravityOAuth,
  completeAntigravityOAuth,
  antigravityOAuthStateStatus,
} = await import('../noroute_src/lib/antigravity-oauth.js');
const {
  backfillAccountIdentity,
  ensureAccountIdentityIndex,
  identityFromToken,
  mergeDuplicateAccounts,
} = await import('../noroute_src/lib/account-identity.js');
// The database module resolves NOROUTER_DB at import time; assert it stayed
// hermetic so the new usage table never touches the operator's real history.
  const { closeDb, DB_FILE, getDb } = await import('../noroute_src/lib/db.js');

assert.equal(DB_FILE, TEST_DB_FILE, 'smoke tests must use the throwaway database');
const { createServer } = await import('../noroute_src/server.js');
const { SESSION_TTL_MS } = await import('../noroute_src/lib/dashboard-session.js');
const { validPort } = await import('../noroute_src/lib/local-config.js');
const { autostartPlatform, autostartSupported, autostartPlan } = await import('../noroute_src/lib/autostart.js');
const { updateNeedsStash } = await import('../noroute_src/lib/git-update.js');

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push(['PASS', name]);
  } catch (err) {
    results.push(['FAIL', name, err.message]);
  }
}

function streamFrom(text) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

// An unsigned JWT is enough for the identity tests: only the payload segment is
// read, and the signature is never checked locally.
function testJwt(payload) {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.`;
}

await test('norouter CLI exposes start, dev, test and version', () => {
  const cli = join(import.meta.dirname, '..', 'noroute_bin', 'norouter.js');
  const help = execFileSync(process.execPath, [cli, 'help'], { encoding: 'utf8' });
  for (const command of ['start', 'restart', 'stop', 'update', 'dev', 'test', 'install', 'autostart-on', 'autostart-off', 'autostart-status', 'uninstall']) {
    assert.match(help, new RegExp(`^\\s+${command}\\b`, 'm'), `${command} must be listed`);
  }
  const version = execFileSync(process.execPath, [cli, 'version'], { encoding: 'utf8' }).trim();
  assert.match(version, /^\d+\.\d+\.\d+/);
  assert.ok(existsSync(join(import.meta.dirname, '..', '.env.example')), '.env.example must exist for norouter install');
  assert.match(help, /background/i);
  assert.equal(updateNeedsStash(''), false);
  assert.equal(updateNeedsStash(' M src/server.js'), true);
  assert.throws(
    () => execFileSync(process.execPath, [cli, 'nope'], { encoding: 'utf8', stdio: 'pipe' }),
    /Unknown command/,
  );
});

await test('prefix form resolves provider and model', () => {
  const r = resolveModel('cbcn/deepseek-v4.1-flash');
  assert.equal(r.provider.id, 'codebuddy-cn');
  assert.equal(r.model, 'deepseek-v4.1-flash');
});

await test('full provider id works as prefix', () => {
  const r = resolveModel('codebuddy-cn/glm-5.3');
  assert.equal(r.model, 'glm-5.3');
});

await test('Codex provider is registered with an account-derived catalog', () => {
  assert.ok(resolveModel('cx/gpt-5.3-codex').error);
  const provider = providers.find((item) => item.id === 'codex');
  assert.equal(provider.format, 'responses');
  assert.equal(provider.chatPath, '/codex/responses');
  assert.equal(provider.requiresAccount, true);
  assert.equal(provider.oauth.fixedPort, 1455);
});

await test('bare model id resolves', () => {
  const r = resolveModel('minimax-m3');
  assert.equal(r.provider.id, 'codebuddy-cn');
  assert.equal(r.model, 'minimax-m3');
});

await test('unknown model is rejected', () => {
  assert.ok(resolveModel('cbcn/not-a-model').error);
  assert.ok(resolveModel('nope').error);
  assert.ok(resolveModel('').error);
});

await test('SSE stream collapses into one completion', async () => {
  const sse = [
    'data: {"id":"abc","created":1,"model":"glm-5.3","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}',
    '',
    'data: {"id":"abc","choices":[{"index":0,"delta":{"content":"lo"}}]}',
    '',
    'data: {"id":"abc","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: {"id":"abc","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');

  const acc = createAccumulator();
  for await (const event of readSSEEvents(streamFrom(sse))) acc.feed(event.data);
  const completion = acc.toCompletion('fallback');

  assert.equal(completion.choices[0].message.content, 'Hello');
  assert.equal(completion.choices[0].finish_reason, 'stop');
  assert.equal(completion.usage.prompt_tokens, 7);
  assert.equal(completion.model, 'glm-5.3');
});

await test('chunk boundaries split mid-line without losing data', async () => {
  const sse =
    'data: {"choices":[{"index":0,"delta":{"content":"ab"}}]}\n\n' +
    'data: {"choices":[{"index":0,"delta":{"content":"cd"}}]}\n\n';
  const bytes = new TextEncoder().encode(sse);
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 7) {
        controller.enqueue(bytes.slice(i, i + 7));
      }
      controller.close();
    },
  });
  const acc = createAccumulator();
  for await (const event of readSSEEvents(stream)) acc.feed(event.data);
  assert.equal(acc.toCompletion('x').choices[0].message.content, 'abcd');
});

await test('tool call fragments are merged by index', async () => {
  const sse = [
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_","arguments":"{\\"a\\":"}}]}}]}',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"weather","arguments":"1}"}}]}}]}',
    'data: [DONE]',
  ].join('\n\n');
  const acc = createAccumulator();
  for await (const event of readSSEEvents(streamFrom(sse))) acc.feed(event.data);
  const calls = acc.toCompletion('x').choices[0].message.tool_calls;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'get_weather');
  assert.equal(calls[0].function.arguments, '{"a":1}');
});

await test('reasoning_content is preserved when present', async () => {
  const sse =
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"think","content":"answer"}}]}\n\n';
  const acc = createAccumulator();
  for await (const event of readSSEEvents(streamFrom(sse))) acc.feed(event.data);
  const message = acc.toCompletion('x').choices[0].message;
  assert.equal(message.content, 'answer');
  assert.equal(message.reasoning_content, 'think');
});

await test('reasoning alias is mirrored for canonical-only clients', () => {
  const streamed = { choices: [{ index: 0, delta: { reasoning: 'think', content: 'answer' } }] };
  assert.equal(mirrorReasoningAlias(streamed), true);
  assert.equal(streamed.choices[0].delta.reasoning_content, 'think');
  assert.equal(streamed.choices[0].delta.reasoning, 'think', 'the original alias stays readable');

  const plain = { choices: [{ index: 0, message: { role: 'assistant', reasoning: 'done' } }] };
  assert.equal(mirrorReasoningAlias(plain), true);
  assert.equal(plain.choices[0].message.reasoning_content, 'done');

  const canonical = { choices: [{ index: 0, delta: { reasoning_content: 'kept', reasoning: 'other' } }] };
  assert.equal(mirrorReasoningAlias(canonical), false, 'a canonical value is never overwritten');
  assert.equal(canonical.choices[0].delta.reasoning_content, 'kept');

  const acc = createAccumulator();
  acc.feed({ choices: [{ index: 0, delta: { reasoning: 'alias' } }] });
  assert.equal(acc.toCompletion('x').choices[0].message.reasoning_content, 'alias');

  // A relayed frame carries both fields; the accumulator must count it once.
  const mirrored = createAccumulator();
  mirrored.feed({ choices: [{ index: 0, delta: { reasoning: 'alias', reasoning_content: 'alias' } }] });
  assert.equal(mirrored.toCompletion('x').choices[0].message.reasoning_content, 'alias');
});

await test('in-stream error frame is captured, not swallowed', async () => {
  const sse = 'data: {"error":{"message":"quota exhausted","type":"rate_limit"}}\n\n';
  const acc = createAccumulator();
  for await (const event of readSSEEvents(streamFrom(sse))) acc.feed(event.data);
  assert.equal(acc.state.error.message, 'quota exhausted');
});

const { server } = createServer({ port: 0, host: '127.0.0.1', logRequests: false });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const DASHBOARD_SCRIPTS = ['core.js','utils.js','custom-select.js','appearance.js','router.js','dashboard.js','providers.js','chat.js','usage.js','combos.js','settings.js','provider-add.js','account-detail.js','account-events.js','service-map.js','glue.js','actions.js','boot.js'];
const fetchDashboardSources = async () => {
  const texts = await Promise.all(DASHBOARD_SCRIPTS.map(async (file) => {
    const response = await fetch(`${base}/assets/${file}`);
    assert.equal(response.status, 200, `${file} must be served`);
    return response.text();
  }));
  return texts.join('\n');
};

await test('autostart planner stays platform-local and secret-free', () => {
  const plan = autostartPlan();
  assert.equal(plan.platform, autostartPlatform());
  assert.equal(plan.supported, autostartSupported());
  assert.ok(!JSON.stringify(plan).includes('ROUTER_API_KEY'));
  const serverScript = plan.command.find((part) => typeof part === 'string' && part.endsWith('server.js'));
  assert.ok(serverScript && existsSync(serverScript), 'autostart must point at the real server entry');
});

await test('autostart settings route reports support and validates updates', async () => {
  const status = await fetch(`${base}/api/settings/autostart`);
  const body = await status.json();
  assert.equal(status.status, 200);
  assert.equal(body.platform, autostartPlatform());
  const invalid = await fetch(`${base}/api/settings/autostart`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: 'yes' }) });
  assert.equal(invalid.status, 400);
});

await test('port configuration validates and settings route reports the listener', async () => {
  assert.equal(validPort(5555), 5555);
  assert.equal(validPort(0), null);
  assert.equal((await import('../noroute_src/lib/local-config.js')).validHost('0.0.0.0'), '0.0.0.0');
  assert.equal((await import('../noroute_src/lib/local-config.js')).validHost(''), null);
  assert.equal(validPort(65536), null);
  const port = await fetch(`${base}/api/settings/port`);
  const body = await port.json();
  assert.equal(port.status, 200);
  assert.equal(body.host, '127.0.0.1');
  assert.equal(body.port, 0);
  const occupied = await fetch(`${base}/api/settings/port`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port: server.address().port }) });
  assert.equal(occupied.status, 409);
});

await test('GET / health and /v1/models', async () => {
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);

  const models = await fetch(`${base}/v1/models`);
  const catalog = await models.json();
  assert.equal(models.status, 200);
  assert.ok(catalog.data.some((m) => m.id === 'cbcn/deepseek-v4.1-flash'));
  assert.ok(!catalog.data.some((m) => m.id === 'deepseek-v4.1-flash'));
  assert.ok(!catalog.data.some((m) => m.id === 'glm-5.3'));
});

await test('chat history CRUD persists text safely and cascades deletes', async () => {
  const created = await fetch(`${base}/api/chat/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '<script>alert(1)</script>', model: 'cbcn/glm-5.3' }),
  });
  assert.equal(created.status, 201);
  const session = (await created.json()).session;
  assert.match(session.title, /script/);
  const message = await fetch(`${base}/api/chat/sessions/${session.id}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'user', content: '<script>alert(1)</script>' }),
  });
  assert.equal(message.status, 201);
  const detail = await (await fetch(`${base}/api/chat/sessions/${session.id}`)).json();
  assert.equal(detail.messages[0].content, '<script>alert(1)</script>');
  assert.equal((await fetch(`${base}/api/chat/sessions/${session.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`${base}/api/chat/sessions/${session.id}`)).status, 404);
});

await test('chat attachment payload accepts bounded text and image content parts', async () => {
  const created = await fetch(`${base}/api/chat/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const session = (await created.json()).session;
  const content = [{ type: 'text', text: 'describe' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }];
  const message = await fetch(`${base}/api/chat/sessions/${session.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'user', content }) });
  assert.equal(message.status, 201);
  const detail = await (await fetch(`${base}/api/chat/sessions/${session.id}`)).json();
  assert.deepEqual(detail.messages[0].content, content);
  await fetch(`${base}/api/chat/sessions/${session.id}`, { method: 'DELETE' });
});

await test('dashboard chat route bypasses /v1 key auth without changing /v1', async () => {
  const protectedServer = createServer({ port: 0, host: '127.0.0.1', requireApiKey: true, apiKey: 'smoke-router-key', logRequests: false }).server;
  await new Promise((resolve) => protectedServer.listen(0, '127.0.0.1', resolve));
  const protectedBase = `http://127.0.0.1:${protectedServer.address().port}`;
  try {
    const internal = await fetch(`${protectedBase}/api/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'cbcn/glm-5.3', stream: true, messages: [{ role: 'user', content: 'internal chat' }] }),
    });
    assert.equal(internal.status, 401, 'internal route must reach provider account checks without router key auth');
    assert.match((await internal.json()).error.message, /Add an account on the provider page/);

    const publicRoute = await fetch(`${protectedBase}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'cbcn/glm-5.3', messages: [{ role: 'user', content: 'public auth' }] }),
    });
    assert.equal(publicRoute.status, 401);
    assert.match((await publicRoute.json()).error.message, /router API key/);
  } finally {
    protectedServer.close();
    const rows = listAccounts('codebuddy-cn', { pageSize: 200 }).items;
    const testRow = rows.find((row) => row.label === 'Internal chat auth test');
    if (testRow) deleteAccount(testRow.id);
  }
});

await test('missing credential returns 401 with guidance', async () => {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'cbcn/glm-5.3',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.match(body.error.message, /Add an account on the provider page/);
});

await test('unknown model returns 400', async () => {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'cbcn/nope', messages: [] }),
  });
  assert.equal(res.status, 400);
});

await test('usage report exposes ranges with a stable shape', async () => {
  const day = await fetch(`${base}/api/usage`);
  assert.equal(day.status, 200);
  const report = await day.json();
  assert.equal(report.range, 'day');
  assert.equal(report.bucket, 'hour');
  assert.equal(report.series.length, 24, 'a day is 24 hourly buckets');
  assert.ok(report.timeZone, 'the report names the local timezone');
  for (const key of ['requests', 'errors', 'tokensIn', 'tokensOut']) assert.equal(typeof report.totals[key], 'number');
  assert.equal(typeof report.totals.cost, 'number');
  assert.equal(report.totals.requests, 0, 'no successful request yet');
  assert.deepEqual(report.models, []);
  for (const item of report.series) {
    assert.equal(typeof item.requests, 'number');
    assert.equal(typeof item.tokensIn, 'number');
  }

  const week = await (await fetch(`${base}/api/usage?range=week`)).json();
  for (const key of ['requests', 'errors', 'tokensIn', 'tokensOut']) assert.equal(typeof week.totals[key], 'number');
  assert.equal(week.range, 'week');
  assert.equal(week.bucket, 'day');
  assert.equal(week.series.length, 7, 'a week is seven daily buckets');

  const month = await (await fetch(`${base}/api/usage?range=month`)).json();
  for (const key of ['requests', 'errors', 'tokensIn', 'tokensOut']) assert.equal(typeof month.totals[key], 'number');
  assert.equal(month.range, 'month');
  assert.equal(month.bucket, 'day');
  assert.ok(month.series.length >= 28 && month.series.length <= 31);

  const all = await (await fetch(`${base}/api/usage?range=all`)).json();
  for (const key of ['requests', 'errors', 'tokensIn', 'tokensOut']) assert.equal(typeof all.totals[key], 'number');
  assert.equal(all.range, 'all');
  assert.equal(all.bucket, 'month');
  assert.ok(all.series.length >= 1);

  assert.ok(Array.isArray(report.activity));
  const invalid = await fetch(`${base}/api/usage?range=nope`);
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error.message, /Unknown range/);

  // /api/status keeps its original in-memory shape.
  const status = await (await fetch(`${base}/api/status`)).json();
  assert.ok(Array.isArray(status.models));
  assert.ok(Array.isArray(status.history));
  assert.equal(typeof status.requests, 'number');
});

await test('provider usage endpoint scopes the report to one provider', async () => {
  const before = await (await fetch(`${base}/api/providers/codebuddy-cn/usage?range=day`)).json();
  const { recordUsageError, recordUsageRequest } = await import('../noroute_src/lib/usage.js');
  recordUsageRequest({ provider: 'codebuddy-cn', model: 'glm-5.3', usage: { prompt_tokens: 120, completion_tokens: 30 }, ms: 250 });
  recordUsageRequest({ provider: 'codex', model: 'gpt-5.1', usage: { prompt_tokens: 900, completion_tokens: 90 }, ms: 400 });
  recordUsageError({ provider: 'codebuddy-cn', model: 'glm-5.3' });

  try {
    const res = await fetch(`${base}/api/providers/codebuddy-cn/usage?range=day`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.provider, 'codebuddy-cn');
    assert.equal(body.range, 'day');
    assert.equal(body.totals.requests, before.totals.requests + 1, 'only the codebuddy request belongs to this report');
    assert.equal(body.totals.tokensIn, before.totals.tokensIn + 120);
    assert.equal(body.totals.tokensOut, before.totals.tokensOut + 30);
    assert.equal(body.totals.errors, before.totals.errors + 1, 'errors stay inside the provider scope');
    assert.ok(body.totals.successRate == null || body.totals.successRate >= 0);
    assert.ok(body.models.some((row) => row.model === 'glm-5.3'));
    assert.ok(!body.models.some((row) => row.model === 'gpt-5.1'), 'another provider must not leak into the model breakdown');
    assert.ok(body.series.every((item) => typeof item.requests === 'number'));
    assert.ok(body.active.every((item) => item.provider === 'codebuddy-cn'));
    assert.ok(!JSON.stringify(body).includes('gpt-5.1'), 'another provider must not leak into the report');

    const all = await (await fetch(`${base}/api/providers/codebuddy-cn/usage?range=all`)).json();
    assert.equal(all.range, 'all');
    assert.ok(all.totals.requests >= before.totals.requests + 1);

    const unknown = await fetch(`${base}/api/providers/nope/usage`);
    assert.equal(unknown.status, 404);
    const invalid = await fetch(`${base}/api/providers/codebuddy-cn/usage?range=nope`);
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error.message, /Unknown range/);
  } finally {
    getDb().prepare("DELETE FROM usage_hourly WHERE model IN ('glm-5.3', 'gpt-5.1')").run();
  }
});

await test('account summary endpoint returns rolling windows and never leaks the token', async () => {
  createAccount('codebuddy-cn', { label: 'Summary account', access_token: 'summary-secret-token' });
  const row = getDb().prepare(
    "SELECT id FROM accounts WHERE provider = 'codebuddy-cn' AND label = 'Summary account' ORDER BY rowid DESC LIMIT 1",
  ).get();
  assert.ok(row?.id, 'seeded account must exist');

  const day = (offset) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
  const insert = getDb().prepare(
    'INSERT INTO account_usage (account_id, day, requests, tokens_in, tokens_out) VALUES (?, ?, ?, ?, ?)',
  );
  insert.run(row.id, day(0), 2, 100, 20);
  insert.run(row.id, day(3), 1, 50, 10);
  insert.run(row.id, day(40), 7, 700, 70);
  // Lifetime comes from the account row, which also counts failed requests.
  getDb().prepare('UPDATE accounts SET requests = 10, tokens_in = 850, tokens_out = 100, errors = 2 WHERE id = ?').run(row.id);

  try {
    const res = await fetch(`${base}/api/providers/codebuddy-cn/accounts/${row.id}/summary`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.provider, 'codebuddy-cn');
    assert.equal(body.timeZone, 'UTC');
    assert.equal(body.account.masked, 'summ••••oken');
    assert.equal(body.windows.day.requests, 2);
    assert.equal(body.windows.week.requests, 3, 'today plus three days ago');
    assert.equal(body.windows.month.requests, 3, 'the 40-day-old row falls outside the month window');
    assert.equal(body.windows.all.requests, 10);
    assert.equal(body.errors, 2);
    assert.equal(body.series.length, 30, 'the popup chart always draws 30 days');
    assert.equal(body.series[29].day, day(0));
    assert.equal(body.series[29].tokensIn, 100);
    assert.ok(!JSON.stringify(body).includes('summary-secret-token'));

    const wrongProvider = await fetch(`${base}/api/providers/codex/accounts/${row.id}/summary`);
    assert.equal(wrongProvider.status, 404, 'an account must not be readable through another provider');
    const unknown = await fetch(`${base}/api/providers/codebuddy-cn/accounts/nope/summary`);
    assert.equal(unknown.status, 404);
  } finally {
    deleteAccount(row.id);
  }
});

await test('Token Saver settings validate and persist', async () => {
  const initial = await (await fetch(`${base}/api/token-saver`)).json();
  assert.deepEqual(initial, { ponytail: { enabled: false }, rtk: { enabled: false }, caveman: { enabled: false } });
  const saved = await fetch(`${base}/api/token-saver`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ponytail: { enabled: true }, rtk: { enabled: true }, caveman: { enabled: true } }),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { ponytail: { enabled: true }, rtk: { enabled: true }, caveman: { enabled: true } });
  assert.deepEqual(await (await fetch(`${base}/api/token-saver`)).json(), { ponytail: { enabled: true }, rtk: { enabled: true }, caveman: { enabled: true } });
  const invalidLegacy = await fetch(`${base}/api/token-saver`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ headroom: { enabled: true } }) });
  assert.equal(invalidLegacy.status, 400);
  const invalidBoolean = await fetch(`${base}/api/token-saver`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ponytail: { enabled: 'yes' } }) });
  assert.equal(invalidBoolean.status, 400);
  const reset = await fetch(`${base}/api/token-saver`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ponytail: { enabled: false }, rtk: { enabled: false }, caveman: { enabled: false } }) });
  assert.equal(reset.status, 200);
});

await test('RTK compresses tool output and fails open', async () => {
  const { compressToolOutput, applyRtk } = await import('../noroute_src/lib/rtk.js');
  // Duplicate log lines collapse.
  const log = 'INFO ok\nINFO ok\nINFO ok\nERROR boom\nERROR boom\n';
  const deduped = compressToolOutput(log);
  assert.ok(deduped.length < log.length, 'repeated lines must shrink');
  assert.match(deduped, /\(×3\)/);
  assert.match(deduped, /ERROR boom/);
  // git diff strips context lines.
  const diff = 'diff --git a/x b/x\nindex 111..222 100644\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n keep\n-removed\n+added\n keep\n';
  const compact = compressToolOutput(diff);
  assert.ok(compact.length < diff.length);
  assert.doesNotMatch(compact, /^ keep$/m);
  assert.match(compact, /-removed/);
  assert.match(compact, /\+added/);
  // A short, unique message is untouched (fail-open, never grows).
  const short = 'hello world';
  assert.equal(compressToolOutput(short), short);
  // applyRtk mutates only tool messages and respects the enabled flag.
  const body = { messages: [{ role: 'tool', content: log }, { role: 'user', content: 'hi' }] };
  const on = applyRtk(body, { rtk: { enabled: true } });
  assert.ok(on.messages[0].content.length < log.length);
  assert.equal(on.messages[1].content, 'hi');
  const off = applyRtk(body, { rtk: { enabled: false } });
  assert.equal(off, body);
});

await test('reply style filters validate, persist and stay idempotent', async () => {
  // Pure unit: idempotency and the no-op default never mutate the body.
  const noop = { language: 'auto', verbosity: 'balanced', coding: false, focus: '', addressAs: '' };
  assert.equal(buildInstruction(noop).includes('same language'), true, 'auto language must inject by default');
  const noopId = { language: 'auto', verbosity: 'balanced', coding: false };
  const once = applyReplyFilters({ messages: [{ role: 'user', content: 'hi' }] }, noopId);
  const twice = applyReplyFilters(once, noopId);
  assert.equal((twice.messages[0].content.match(/\[norouter reply style\]/g) || []).length, 1, 'repeated apply must not stack instructions');
  const japanese = applyReplyFilters({ messages: [{ role: 'user', content: 'hello' }] }, { language: 'ja', verbosity: 'balanced', coding: false });
  assert.match(japanese.messages[0].content, /日本語/);
  assert.equal((applyReplyFilters(japanese, { language: 'ja', verbosity: 'balanced', coding: false }).messages[0].content.match(/\[norouter reply style\]/g) || []).length, 1);
  const untouched = applyReplyFilters({ messages: [{ role: 'user', content: 'x' }] }, { language: 'none', verbosity: 'balanced', coding: false });
  assert.deepEqual(untouched.messages, [{ role: 'user', content: 'x' }], 'all no-op settings must return the body unchanged');
  assert.equal(buildInstruction({ language: 'none', verbosity: 'balanced', coding: false }), '');

  // Custom focus and address lines stay on one instruction per line.
  const custom = { language: 'none', verbosity: 'balanced', coding: false, focus: 'Stay on backend debugging.\nPrefer Node examples.', addressAs: 'Dimas' };
  const customInstruction = buildInstruction(custom);
  assert.match(customInstruction, /Operator focus: Stay on backend debugging\./);
  assert.match(customInstruction, /\[norouter reply style\] Prefer Node examples\./);
  assert.match(customInstruction, /Address the user as "Dimas"\./);
  const customTwice = applyReplyFilters(applyReplyFilters({ messages: [{ role: 'user', content: 'hi' }] }, custom), custom);
  assert.equal((customTwice.messages[0].content.match(/\[norouter reply style\]/g) || []).length, 3, 'focus and address lines must not stack on replay');

  // Endpoint: defaults, valid patch, invalid patches.
  const defaults = await (await fetch(`${base}/api/reply-filters`)).json();
  assert.deepEqual(defaults, { language: 'auto', verbosity: 'balanced', coding: false, focus: '', addressAs: '' });
  const patched = await fetch(`${base}/api/reply-filters`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ language: 'id', verbosity: 'concise', coding: true, focus: 'Stay on backend debugging.', addressAs: 'Dimas' }),
  });
  assert.equal(patched.status, 200);
  assert.deepEqual(await patched.json(), { language: 'id', verbosity: 'concise', coding: true, focus: 'Stay on backend debugging.', addressAs: 'Dimas' });
  assert.deepEqual(await (await fetch(`${base}/api/reply-filters`)).json(), { language: 'id', verbosity: 'concise', coding: true, focus: 'Stay on backend debugging.', addressAs: 'Dimas' });

  for (const bad of [
    { language: 'xx' },
    { verbosity: 'loud' },
    { coding: 'yes' },
    { focus: 5 },
    { focus: 'x'.repeat(2001) },
    { addressAs: 5 },
    { addressAs: 'x'.repeat(61) },
    { addressAs: 'two\nlines' },
    { language: 'id', extra: true },
  ]) {
    const res = await fetch(`${base}/api/reply-filters`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bad) });
    assert.equal(res.status, 400, JSON.stringify(bad));
  }

  // Reset to defaults so later chat-path assertions start clean.
  await fetch(`${base}/api/reply-filters`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ language: 'auto', verbosity: 'balanced', coding: false, focus: '', addressAs: '' }) });
});

await test('reply style instructions reach the upstream and no-op leaves the body alone', async () => {
  const created = await fetch(`${base}/api/providers/codebuddy-cn/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Reply style account', access_token: 'reply-style-token' }),
  });
  assert.equal(created.status, 201);
  try {
    // language='id' plus a custom focus and name must reach the upstream prompt.
    await fetch(`${base}/api/reply-filters`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ language: 'id', verbosity: 'balanced', coding: false, focus: 'Stay on backend debugging.', addressAs: 'Dimas' }) });
    chatBodies.length = 0;
    const withId = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'cbcn/glm-5.3', messages: [{ role: 'user', content: 'halo' }] }),
    });
    assert.equal(withId.status, 200, await withId.clone().text());
    const idUpstream = chatBodies.find((item) => item.model === 'glm-5.3');
    assert.ok(idUpstream, 'chat must reach the stub');
    const idSystem = idUpstream.messages.find((message) => message.role === 'system');
    assert.ok(idSystem?.content.includes('Bahasa Indonesia'), 'id instruction must be present in the upstream system message');
    assert.match(idSystem.content, /Operator focus: Stay on backend debugging\./);
    assert.match(idSystem.content, /Address the user as "Dimas"\./);

    // Idempotency across the wire: replaying the returned history must not stack.
    chatBodies.length = 0;
    const replay = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'cbcn/glm-5.3', messages: idUpstream.messages }),
    });
    assert.equal(replay.status, 200);
    const replaySystem = chatBodies.find((item) => item.model === 'glm-5.3')?.messages.find((message) => message.role === 'system');
    assert.equal((replaySystem.content.match(/\[norouter reply style\]/g) || []).length, 3, 'replayed history must not duplicate the instruction');

    // All no-op: the upstream body must equal the client body exactly.
    await fetch(`${base}/api/reply-filters`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ language: 'none', verbosity: 'balanced', coding: false, focus: '', addressAs: '' }) });
    chatBodies.length = 0;
    const plain = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'cbcn/glm-5.3', messages: [{ role: 'user', content: 'plain' }] }),
    });
    assert.equal(plain.status, 200);
    const plainUpstream = chatBodies.find((item) => item.model === 'glm-5.3');
    assert.deepEqual(plainUpstream.messages, [{ role: 'user', content: 'plain' }], 'no-op filters must not alter the message list');
  } finally {
    await fetch(`${base}/api/reply-filters`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ language: 'auto', verbosity: 'balanced', coding: false, focus: '', addressAs: '' }) });
    const account = (await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json()).items
      .find((item) => item.label === 'Reply style account');
    if (account) await fetch(`${base}/api/providers/codebuddy-cn/accounts/${account.id}`, { method: 'DELETE' });
  }
});

await test('reply style instruction survives the Responses translation', async () => {
  const settings = { language: 'en', verbosity: 'detailed', coding: true, focus: 'Stay on backend debugging.', addressAs: 'Dimas' };
  const body = applyReplyFilters({ model: 'cx/gpt-5.3-codex', messages: [{ role: 'user', content: 'hi' }] }, settings);
  const responses = toResponsesRequest(body);
  const system = responses.input.find((item) => item.role === 'system');
  assert.ok(system, 'responses input must carry the injected system message');
  assert.match(system.content, /Operator focus: Stay on backend debugging\./);
  assert.match(system.content, /Address the user as "Dimas"\./);
  assert.match(system.content, /Reply in English\./);
  assert.match(system.content, /Explain thoroughly/);
  assert.match(system.content, /Prefer short, minimal code/);
  assert.equal((system.content.match(/\[norouter reply style\]/g) || []).length, 5, 'five instructions share five markers');
});

await test('dashboard password protection gates dashboard routes and rotates safely', async () => {
  const getStatus = async () => (await fetch(`${base}/api/auth/status`)).json();
  assert.deepEqual(await getStatus(), { enabled: false, authenticated: false });
  assert.equal((await fetch(`${base}/api/auth/settings`, { method: 'GET' })).status, 200);

  const enabled = await fetch(`${base}/api/auth/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
  assert.equal(enabled.status, 200);
  assert.equal(SESSION_TTL_MS, 60 * 60 * 1000);
  const enabledCookie = enabled.headers.get('set-cookie');
  assert.match(enabledCookie, /HttpOnly/);
  assert.match(enabledCookie, /SameSite=Lax/);
  assert.match(enabledCookie, /Max-Age=3600/);
  assert.equal((await (await fetch(`${base}/api/auth/status`)).json()).enabled, true);
  const lockedPage = await fetch(`${base}/`, { headers: { cookie: '' } });
  assert.equal(lockedPage.status, 401);
  const lockedHtml = await lockedPage.text();
  assert.match(lockedHtml, /<body class="dashboard-locked" data-dashboard-locked="true">/);
  assert.match(lockedHtml, /dashboard-lock-ready/);
  assert.equal((await fetch(`${base}/assets/core.js`, { headers: { cookie: '' } })).status, 200);
  assert.equal((await fetch(`${base}/api/status`, { headers: { cookie: '' } })).status, 200);
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/v1/models`)).status, 200);

  const bad = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrong-password' }) });
  assert.equal(bad.status, 401);
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: '123456' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(`${base}/`, { headers: { cookie } })).status, 200);
  const meta = getDb().prepare('SELECT key, value FROM meta WHERE key LIKE \'dashboard_auth.%\'').all();
  assert.ok(meta.every((row) => !row.value.includes('123456')), 'default password must not be stored plaintext');

  const rotated = await fetch(`${base}/api/auth/password`, { method: 'PATCH', headers: { cookie: '', 'content-type': 'application/json' }, body: JSON.stringify({ password: 'new-dashboard-password' }) });
  assert.equal(rotated.status, 200);
  assert.equal((await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: '123456' }) })).status, 401);
  const newLogin = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'new-dashboard-password' }) });
  assert.equal(newLogin.status, 200);
  const newCookie = newLogin.headers.get('set-cookie').split(';')[0];
  const disabled = await fetch(`${base}/api/auth/settings`, { method: 'PATCH', headers: { cookie: newCookie, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
  assert.equal(disabled.status, 200);
  assert.equal((await fetch(`${base}/`)).status, 200);
  const dashboardJs = await fetchDashboardSources();
  assert.doesNotMatch(dashboardJs, /handleDashboardSessionExpired/);
  assert.doesNotMatch(dashboardJs, /Dashboard authentication required/);

  for (let i = 0; i < 5; i += 1) {
    await fetch(`${base}/api/auth/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
    const attempt = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'nope' }) });
    if (i === 4) assert.equal(attempt.status, 429);
  }
  await fetch(`${base}/api/auth/settings`, { method: 'PATCH', headers: { cookie: newCookie, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
});

await test('dashboard, chat shell and status endpoint respond', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /norouter/);
  const chat = await fetch(`${base}/chat`);
  const chatHtml = await chat.text();
  assert.equal(chat.status, 200);
  assert.match(chatHtml, /data-page="\/chat"/);
  assert.match(chatHtml, /id="chatModel"[^>]*data-custom-select/);
  assert.match(chatHtml, /id="chatTranscript"[^>]*role="log"/);

  // The chat transcript is its own scroll container and auto-follows the
  // stream only while the reader is near the bottom; these helpers are the
  // client contract that keeps the viewport from jumping during streaming.
  const chatJs = await fetchDashboardSources();
  assert.match(chatJs, /function chatNearBottom/);
  assert.match(chatJs, /function chatScrollToBottom/);
  assert.match(chatJs, /chatScrollToBottom\(\)/);

  // Height comes from the flex chain, not a per-viewport magic number, and the
  // transcript rule must outrank `.card { overflow: hidden }`.
  const chatCss = await (await fetch(`${base}/assets/styles.css`)).text();
  assert.doesNotMatch(chatCss, /max-height:\s*calc\(100dvh\s*-\s*300px\)/);
  assert.doesNotMatch(chatCss, /max-height:\s*calc\(100dvh\s*-\s*360px\)/);
  assert.match(chatCss, /\.chat-page\s+\.chat-transcript\s*\{[^}]*overflow-y:\s*auto/);
  const status = await fetch(`${base}/api/status`);
  const snapshot = await status.json();
  assert.equal(snapshot.providers[0].id, 'codebuddy-cn');
  assert.ok(snapshot.providers[0].modelIds.length > 0);
  assert.ok(['pool', 'open', 'missing'].includes(snapshot.providers[0].credential));
});

await test('chat stream emits incremental content and handles in-stream errors', async () => {
  const created = await fetch(`${base}/api/providers/codebuddy-cn/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Chat smoke account', access_token: 'chat-smoke-token' }),
  });
  assert.equal(created.status, 201);

  const stream = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'cbcn/glm-5.3', stream: true, messages: [{ role: 'user', content: 'chat smoke' }] }),
  });
  assert.equal(stream.status, 200);
  const events = [];
  for await (const event of readSSEEvents(stream.body)) events.push(event.data);
  const content = events.map((event) => event.choices?.[0]?.delta?.content || '').join('');
  assert.match(content, /stub reply for glm-5\.3/);
  assert.ok(events.length > 2, 'stream must arrive in multiple frames');
  // A streamed client turn still has to ask for the usage chunk; without it the
  // activity row is a 200 with zero tokens.
  assert.equal(chatBodies.at(-1).stream_options?.include_usage, true);
  const historicalAfterChat = await (await fetch(`${base}/api/usage?range=day`)).json();
  assert.ok(historicalAfterChat.totals.requests >= 1, 'historical request total must persist');
  assert.ok(historicalAfterChat.totals.tokensIn > 0, 'historical input tokens must persist');
  assert.ok(historicalAfterChat.totals.tokensOut > 0, 'historical output tokens must persist');

  const errorStream = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'cbcn/glm-5.3-flash', stream: true, messages: [{ role: 'user', content: 'error smoke' }] }),
  });
  assert.equal(errorStream.status, 200);
  const errorEvents = [];
  for await (const event of readSSEEvents(errorStream.body)) errorEvents.push(event.data);
  assert.equal(errorEvents[0]?.error?.type, 'rate_limit');

  const pool = await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json();
  const account = pool.items.find((item) => item.label === 'Chat smoke account');
  if (account) await fetch(`${base}/api/providers/codebuddy-cn/accounts/${account.id}`, { method: 'DELETE' });
});

await test('dashboard icon is linked and served as SVG', async () => {
  const page = await (await fetch(`${base}/`)).text();
  assert.match(page, /rel="icon"[^>]*href="\/assets\/icon\.svg"/);
  const icon = await fetch(`${base}/assets/icon.svg`);
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get('content-type') || '', /image\/svg\+xml/);
  assert.match(await icon.text(), /<svg[^>]*viewBox="0 0 64 64"/);
});

await test('cost estimation bills known models and leaves unknowns null', async () => {
  const { modelPricing, estimateCost } = await import('../noroute_src/lib/pricing.js');
  const glm = modelPricing('glm-5.3');
  assert.ok(glm, 'glm-5.3 has a rate');
  assert.ok(glm.input > 0 && glm.output > 0);
  // Case-insensitive lookup for the catalog's lowercase ids.
  assert.ok(modelPricing('GLM-5.3'));
  // 1M in + 1M out at input 1.0 / output 4.0 = $5.00.
  assert.equal(estimateCost(1_000_000, 1_000_000, modelPricing('glm-5.3')), 5);
  // Unknown and combo models have no invented rate.
  assert.equal(modelPricing('not-a-model'), null);
  assert.equal(estimateCost(1000, 1000, null), null);
});

await test('request log records and clears redacted metadata', async () => {
  const { recordRequestLog, requestLogs, redact } = await import('../noroute_src/lib/request-log.js');
  const before = requestLogs().length;
  recordRequestLog({
    provider: 'codebuddy-cn',
    model: 'glm-5.3',
    account: 'cbcn_1',
    tokensIn: 12,
    tokensOut: 3,
    ms: 40,
    status: 200,
    requested: 'cbcn/glm-5.3',
    route: 'combo',
    via: 'premium-coding',
    attempted: ['cbcn/combo-always-429', 'cbcn/glm-5.3'],
    image: true,
  });
  recordRequestLog({ provider: 'codebuddy-cn', model: 'x', status: 502, error: 'Bearer abc123 failed' });
  recordRequestLog({ route: 'bogus-reason' });
  const logs = requestLogs();
  assert.equal(logs.length, before + 3);
  assert.equal(logs[logs.length - 2].status, 502);
  assert.doesNotMatch(logs[logs.length - 2].error, /abc123/, 'tokens must be redacted');
  assert.match(logs[logs.length - 2].error, /\[redacted\]/);

  // The routing trace keeps only names and the reason, and unknown reasons are
  // dropped instead of being rendered as a route badge.
  const traced = logs[logs.length - 3];
  assert.equal(traced.requested, 'cbcn/glm-5.3');
  assert.equal(traced.route, 'combo');
  assert.equal(traced.via, 'premium-coding');
  assert.deepEqual(traced.attempted, ['cbcn/combo-always-429', 'cbcn/glm-5.3']);
  assert.equal(traced.image, true);
  assert.equal(logs[logs.length - 1].route, null);
  assert.deepEqual(logs[logs.length - 1].attempted, []);

  // The HTTP route reads and clears; run it against a real server instance.
  const clear = await fetch(`${base}/api/request-log`, { method: 'DELETE' });
  assert.equal(clear.status, 200);
  const after = await (await fetch(`${base}/api/request-log`)).json();
  assert.ok(Array.isArray(after.requests));

  // Secret redaction is content-independent of the buffer.
  assert.equal(redact('Bearer eyJhbGciOiJIUzI1NiJ9.secret'), 'Bearer [redacted]');
});

await test('webhook settings validate and persist', async () => {
  const initial = await (await fetch(`${base}/api/webhook`)).json();
  assert.equal(initial.enabled, false);
  const saved = await fetch(`${base}/api/webhook`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true, url: 'http://127.0.0.1:1/hook' }),
  });
  assert.equal(saved.status, 200);
  const body = await saved.json();
  assert.equal(body.enabled, true);
  assert.equal(body.url, 'http://127.0.0.1:1/hook');
  const bad = await fetch(`${base}/api/webhook`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'not-a-url' }),
  });
  assert.equal(bad.status, 400);
  const reset = await fetch(`${base}/api/webhook`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false, url: '' }),
  });
  assert.equal(reset.status, 200);
});

await test('settings exposes accessible tabs and Token Saver controls', async () => {
  const html = await (await fetch(`${base}/settings`)).text();
  assert.match(html, /id="settingsTabs"[^>]*role="tablist"/);
  assert.equal((html.match(/data-settings-tab=/g) || []).length, 5);
  assert.equal((html.match(/id="settingsTab[^" ]+"[^>]*role="tab"/g) || []).length, 5);
  assert.match(html, /id="settingsTabAppearance"[^>]*aria-controls="settingsPanelAppearance"/);
  assert.match(html, /id="settingsPanelAppearance"[^>]*role="tabpanel"/);
  assert.match(html, /id="settingsTabTokenSaver"[^>]*aria-controls="settingsPanelTokenSaver"/);
  assert.match(html, /id="settingsPanelTokenSaver"[^>]*role="tabpanel"/);
  assert.match(html, /id="settingsTabReply"[^>]*aria-controls="settingsPanelReply"/);
  assert.match(html, /id="settingsPanelReply"[^>]*role="tabpanel"/);
  assert.match(html, /id="replyLanguageTrigger"[^>]*aria-controls="replyLanguagePopup"/);
  assert.match(html, /id="replyLanguageSearch"[^>]*type="search"/);
  assert.match(html, /id="replyLanguageGrid"[^>]*role="listbox"/);
  assert.match(html, /id="replyVerbosity"[^>]*data-custom-select/);
  assert.match(html, /id="replyCoding"[^>]*type="checkbox"/);
  assert.match(html, /id="replyFocus"[^>]*maxlength="2000"/);
  assert.match(html, /id="replyAddressAs"[^>]*maxlength="60"/);
  assert.match(html, /id="saveReplyInstructions"[^>]*type="button"/);
  assert.match(html, /id="replyFiltersNote"[^>]*role="status"/);
  assert.match(html, /id="tokenSaverPonytail"[^>]*type="checkbox"/);
  assert.match(html, /id="tokenSaverRtk"[^>]*type="checkbox"/);
  assert.match(html, /id="tokenSaverCaveman"[^>]*type="checkbox"/);
  assert.match(html, /id="tokenSaverNote"[^>]*role="status"/);
  assert.match(html, /id="webhookToggle"[^>]*type="checkbox"/);
  assert.match(html, /id="webhookUrl"[^>]*type="url"/);
  assert.match(html, /id="requestLogTable"/);
  // The request log pages at ten rows so the 200-entry buffer stays readable.
  assert.match(html, /id="requestLogPager"[^>]*aria-label="Request log pages"/);
  assert.match(html, /id="requestLogPageBtns"/);
  const js = await fetchDashboardSources();
  assert.match(js, /ArrowRight/);
  assert.match(js, /settingsTab/);
  assert.match(js, /replyFilters/);
  assert.doesNotMatch(js, /document\.querySelectorAll\('\.dtab'\)\.forEach/);
  assert.match(js, /document\.querySelectorAll\('#dTabs \.dtab'\)/);
  assert.match(js, /\/api\/reply-filters/);
  assert.match(js, /\/assets\/flags\/\$\{item\.flag\}\.png/);
  assert.ok((js.match(/\['[^']+',\s*'[^']*',\s*'[^']*',\s*'[^']*'\]/g) || []).length >= 100);
  assert.match(js, /\['za',\s*'Saɯ cueŋƅ',\s*'Zhuang'/);
  const flag = await fetch(`${base}/assets/flags/id.png`);
  assert.equal(flag.status, 200);
  assert.match(flag.headers.get('content-type') || '', /image\/png/);
  assert.ok((await flag.arrayBuffer()).byteLength > 0);
  assert.match(html, /id="replyLanguageTrigger"[^>]*aria-controls="replyLanguagePopup"/);
  assert.match(html, /id="replyLanguageSearch"[^>]*type="search"/);
  assert.match(html, /id="replyLanguageGrid"[^>]*role="listbox"/);
  assert.doesNotMatch(html, /id="replyLanguage"[^>]*data-custom-select/);
});

await test('dashboard shell keeps navigation and control ownership consistent', async () => {
  const html = await (await fetch(`${base}/`)).text();
  const rail = [...html.matchAll(/<a class="rail-btn" href="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(rail, ['/', '/map', '/chat', '/providers', '/usage', '/api-keys', '/combos', '/settings']);
  assert.equal((html.match(/id="requireKeyToggle"/g) || []).length, 1);
  assert.match(html, /id="pageTitle">Dashboard<\/h1>/);

  const providers = await (await fetch(`${base}/providers`)).text();
  assert.match(providers, /class="page-intro">Manage upstream endpoints, accounts, and available models\.<\/p>/);

  const js = await fetchDashboardSources();
  assert.match(js, /const provider = detail\.provider \|\| \{\};/);
  assert.match(js, /escapeHtml\(value\)/);
  assert.match(html, /id="apoolMore"/);
  assert.match(html, /id="poolItemCheckin"/);
  assert.match(html, /id="poolHead"/);
  assert.match(html, /id="poolCount"/);
  assert.match(html, /id="poolFill"/);
  assert.match(html, /id="poolBusy"/);
  assert.match(js, /data-account-action="edit"/);
  assert.match(js, /Account name/);
});

await test('dashboard omits duplicate providers and health cards while Settings keeps status', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.doesNotMatch(html, /<article class="card[^>]*>\s*[\s\S]*?Providers[\s\S]*?id="providerList"/);
  assert.doesNotMatch(html, /id="providerList"|id="providerHint"|id="healthStatus"|id="healthUptime"|id="healthPort"|id="healthKey"|id="healthChip"/);
  assert.doesNotMatch(html, /<h2 class="card-title">Health<\/h2>/);
  assert.match(html, /id="sStatus"/);
  assert.match(html, /id="sUptime"/);
  assert.match(html, /id="sPort"/);

  const js = await fetchDashboardSources();
  for (const id of ['providerList', 'providerHint', 'healthStatus', 'healthUptime', 'healthPort', 'healthKey', 'healthChip']) {
    assert.doesNotMatch(js, new RegExp(`\\$\\('${id}'\\)`), `${id} must not be queried by dashboard code`);
  }
  assert.match(js, /sUptime/);
});

await test('dashboard shell ships viewport meta and its assets', async () => {
  const page = await fetch(`${base}/`);
  const html = await page.text();
  assert.equal(page.status, 200);
  // Mobile support depends on this; without it the layout renders at 980px.
  assert.match(html, /<meta\s+name="viewport"[^>]*width=device-width/);
  assert.match(html, /href="\/assets\/styles\.css"/);
  assert.match(html, /src="\/assets\/core\.js"/);
  // Split modules load in dependency order; the last one must be the boot script.
  const scripts = [...html.matchAll(/src="\/assets\/([a-z0-9-]+\.js)"/g)].map((m) => m[1]);
  assert.deepEqual(scripts, DASHBOARD_SCRIPTS, 'dashboard must load every script in order');
  assert.match(html, /<section class="page[^"]*" data-page="\/" hidden>/, 'dashboard must not paint before the initial route');
  assert.match(html, /<div class="splash" id="appSplash"[^>]*>/);
  assert.match(html, /dashboard-booting/);
  assert.match(html, /html\.dashboard-booting \{ overflow: hidden; \}/);

  const css = await fetch(`${base}/assets/styles.css`);
  assert.equal(css.status, 200, 'styles asset must be served');
  assert.match(css.headers.get('content-type') || '', /text\/css/);

  for (const file of DASHBOARD_SCRIPTS) {
    const js = await fetch(`${base}/assets/${file}`);
    assert.equal(js.status, 200, `${file} must be served`);
    assert.match(js.headers.get('content-type') || '', /javascript/, `${file} must be javascript`);
  }
});

await test('dashboard scripts never reference a later script by bare identifier', async () => {
  // Classic scripts share one global scope: naming a later module's function
  // directly throws at load time and silently kills the rest of that file.
  const sources = await Promise.all(DASHBOARD_SCRIPTS.map(async (file) => [file, await (await fetch(`${base}/assets/${file}`)).text()]));
  const declared = new Map(sources.map(([file, text]) => [file, new Set([
    ...[...text.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)].map((match) => match[1]),
    ...[...text.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)].map((match) => match[1]),
  ])]));
  const seen = new Set();
  const broken = [];
  for (const [file, text] of sources) {
    const target = text.replace(/`[^`]*`|"[^"]*"|'[^']*'/g, '');
    const later = new Set(DASHBOARD_SCRIPTS.slice(DASHBOARD_SCRIPTS.indexOf(file) + 1).flatMap((name) => [...(declared.get(name) || [])]));
    for (const match of target.matchAll(/(?:^|[=(,:\s!&|?])([A-Za-z_$][\w$]*)\s*(?=[,;)])/g)) {
      const id = match[1];
      if (!seen.has(id) && later.has(id)) broken.push(`${file}:${target.slice(0, match.index).split('\n').length} ${id}`);
    }
    (declared.get(file) || []).forEach((name) => seen.add(name));
  }
  assert.deepEqual(broken, [], 'wrap the reference in an arrow function so it resolves at call time');
});

await test('service map ships the full page without a dashboard card', async () => {
  const page = await fetch(`${base}/map`);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /<section class="page[^"]*map-page[^"]*" data-page="\/map" hidden>/);
  assert.doesNotMatch(html, /data-service-map="compact"/, 'the dashboard must not mount a compact map');
  assert.match(html, /<div class="service-map" data-service-map="full">/);
  assert.match(html, /href="\/map" data-route="\/map"/);

  const js = await fetchDashboardSources();
  assert.match(js, /new EventSource\('\/api\/live'\)/, 'the map must subscribe to the live stream');
  assert.match(js, /prefers-reduced-motion/, 'the map must honor reduced motion');
});

await test('every dashboard select uses the custom dropdown', async () => {
  const html = await (await fetch(`${base}/`)).text();
  const selects = [...html.matchAll(/<select\b[^>]*>/g)].map((m) => m[0]);
  assert.ok(selects.length >= 5, 'expected the dashboard selects to still be present');
  const native = selects.filter((tag) => !/data-custom-select/.test(tag));
  assert.deepEqual(native, [], 'no select may render with native chrome');

  const js = await fetchDashboardSources();
  assert.match(js, /function enhanceSelect/, 'the enhancer must ship with the dashboard');

  const css = await (await fetch(`${base}/assets/styles.css`)).text();
  // One global scrollbar rule instead of per-container native chrome.
  assert.match(css, /::-webkit-scrollbar\s*\{/, 'scrollbars must be styled');
  assert.match(css, /scrollbar-color:/, 'Firefox scrollbar colours must be set');
  assert.match(css, /\.splash\s*\{[^}]*view-transition-name:\s*none/);
  assert.match(js, /navigate\(location\.pathname, \{ push: false, initial: true \}\)/);
  assert.match(js, /transitionPages\(pageKey, \(\) => \{[\s\S]*animate: !initial && !booting/);
});

await test('providers page exposes its heading and grid scaffolding', async () => {
  const html = await (await fetch(`${base}/providers`)).text();
  assert.equal((await fetch(`${base}/providers`)).status, 200);
  // The section heading and its count chip give the page a start; the grid and
  // the add tile are its only children, in that order.
  assert.match(html, /class="pghead"[\s\S]{0,300}id="pgCount"/);
  assert.match(html, /<div class="pgrid" id="providerCards"><\/div>/);
  assert.ok(
    html.indexOf('id="providerCards"') < html.indexOf('data-page="/api-keys"'),
    'the provider grid must stay before the API keys page',
  );
  assert.match(html, /data-page="\/api-keys"[\s\S]{0,1200}class="card curl-card"/);
});

await test('API Keys page has clear control and action hierarchy', async () => {
  const html = await (await fetch(`${base}/api-keys`)).text();
  assert.match(html, /id="requireKeyToggle"/);
  assert.equal((html.match(/id="requireKeyToggle"/g) || []).length, 1, 'Require API key must have one active control');
  assert.match(html, /<strong id="keyProtection"[^>]*>Not protected<\/strong>/);
  const protection = html.match(/<strong id="keyProtection"[^>]*>[\s\S]*?<\/strong>/)?.[0] || '';
  assert.doesNotMatch(protection, /<(?:input|button|select)\b/);
  assert.match(html, /id="copyKeyEndpoint"[^>]*>Copy URL</);
  assert.match(html, /id="copyCurl"[^>]*>Copy example</);
  assert.match(html, /data-page="\/api-keys"[\s\S]*class="card key-vault"/);
  const js = await fetchDashboardSources();
  assert.match(js, /No secret stored — rotate to issue one/);
  assert.match(js, /data-create-key-empty/);
  assert.match(js, /data-key-revoke/);
  assert.match(js, /key\.secret \? `.*data-key-show/);
  assert.match(js, /key\.secret \? `.*data-key-copy/);
  const css = await (await fetch(`${base}/assets/styles.css`)).text();
  assert.match(css, /\.key-row\s*\{[^}]*grid-template-columns:\s*38px/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.key-row\s*\{[^}]*grid-template-columns:\s*34px minmax\(0, 1fr\)/);
  assert.match(css, /\.key-row-actions\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(css, /\.key-more\s*>\s*summary/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});

await test('dashboard cards use persisted SQLite usage data', async () => {
  const html = await (await fetch(`${base}/`)).text();
  // The chart card is the range tabpanel; its heading names the data it plots.
  assert.match(html, /id="dashboardHistoryPanel"[^>]*>[\s\S]{0,160}<h2 class="card-title">Request volume<\/h2>/);
  assert.match(html, /Persisted usage for the selected range/);
  assert.doesNotMatch(html, /Persisted usage from SQLite|Persisted requests from SQLite/);
  const js = await fetchDashboardSources();
  assert.match(js, /renderStatistics\(latest \|\| \{\}, report\)/);
  assert.match(js, /renderRequests\(latest \|\| \{\}, report\)/);
  assert.match(js, /renderModels\(latest \|\| \{\}, report\)/);
  assert.match(js, /const rows = recentRows\(data, report\);/);
  assert.match(js, /\.\.\.\(report\?\.activity \|\| \[\]\)/);
  assert.match(js, /totals\.tokensIn/);
});

await test('dashboard has branded logo and motion polish', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /class="rail-logo"><svg[^>]*aria-label="norouter"/);
  assert.match(html, /class="splash-mark"><svg[^>]*aria-label="norouter"/);
  const css = await (await fetch(`${base}/assets/styles.css`)).text();
  assert.match(css, /prefers-reduced-motion: reduce/);
  // The pointer-following glow was decorative noise; the design keeps motion
  // limited to state transitions that honour reduced-motion.
  assert.doesNotMatch(html, /class="pointer-glow"/);
  const js = await fetchDashboardSources();
  assert.doesNotMatch(js, /paintPointerGlow/);
});

await test('dashboard keeps connection actions compact and useful', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /class="topbar-connect"[^>]*id="topbarConnect"/);
  assert.match(html, /id="copyBase"[^>]*>Copy</);
  assert.match(html, /id="copyApiKey"/);
  assert.match(html, /id="dashboardApiKey"/);
  assert.doesNotMatch(html, /<h2 class="card-title">Connect<\/h2>/);
  assert.doesNotMatch(html, /copyBase3/);
  // Storage branding stays out of the connect actions; the rail foot names the
  // store once, so scope the check to the header block.
  const connectBlock = html.slice(html.indexOf('id="topbarConnect"'), html.indexOf('</header>'));
  assert.ok(connectBlock.length > 0, 'connect block must stay inside the header');
  assert.doesNotMatch(connectBlock, /SQLite/);
  const js = await fetchDashboardSources();
  assert.match(js, /function renderDashboardConnect/);
  assert.match(js, /dashboardApiKeySecret/);
  assert.match(js, /copyText\(dashboardApiKeySecret\)/);
});

await test('dashboard declares its data ranges and chart summary', async () => {
  const html = await (await fetch(`${base}/`)).text();
  // The range tabs own the window; each chip says which window it covers.
  assert.match(html, /id="statRangeChip"[^>]*>today</);
  assert.match(html, /id="reqRangeChip"[^>]*>since start</);
  assert.match(html, /id="dashboardRangeTabs"[^>]*role="tablist"/);
  assert.equal((html.match(/data-dashboard-range=/g) || []).length, 4);
  // The chart is the tabpanel the range tabs control, and the stat block keeps
  // the same five persisted counters the API reports.
  assert.match(html, /id="dashboardHistoryPanel"[^>]*role="tabpanel"/);
  for (const id of ['statRequests', 'statIn', 'statOut', 'statLatency', 'statErrors']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} must render`);
  }
  assert.match(html, /class="dash-note">Persisted usage for the selected range, plus live uptime\./);
  // The chart needs a text equivalent that does not depend on hovering a bar.
  assert.match(html, /id="sparkSummary"/);
  assert.match(html, /id="sparkWindow"/);
  // The base URL stays visible in the header instead of being buried below the fold.
  assert.match(html, /id="topbarConnect"/);
  // Usage breakdown and activity paginate client-side at ten rows.
  assert.match(html, /id="uModelPager"[^>]*aria-label="Breakdown by model pages"/);
  assert.match(html, /id="uModelPageInfo"/);
  assert.match(html, /id="uModelPageBtns"/);
  assert.match(html, /id="uActivityPager"[^>]*aria-label="Activity pages"/);
  assert.match(html, /id="uActivityPageBtns"/);
  // The dashboard has one request card: paged at five rows on phones.
  assert.match(html, /id="recentPager"[^>]*aria-label="Recent requests pages"/);
  assert.match(html, /id="recentPageBtns"/);
  // Activity was folded into that table, so the old list is gone for good.
  assert.equal(/id="eventList"/.test(html), false);
  assert.match(html, /id="uChartTypes"[^>]*role="tablist"/);
  assert.equal((html.match(/data-usage-chart=/g) || []).length, 4);
  assert.equal((html.match(/role="tab"[^>]*data-usage-chart=/g) || []).length, 4);
  assert.match(html, /id="uSparkLegend"/);
  const js = await fetchDashboardSources();
  assert.match(js, /\/api\/usage\?range=/);
  assert.match(js, /data-dashboard-range/);
  assert.match(js, /const USAGE_PAGE_SIZE = 10;/);
  assert.match(js, /const DASH_MOBILE_PAGE_SIZE = 5;/);
  assert.match(js, /usage-page-btn/);
  assert.match(js, /aria-current/);
  assert.match(js, /is-streaming/);
  assert.match(js, /Streaming/);
  assert.match(js, /usageData\?\.active/);
  for (const type of ['heatmap', 'bars', 'line', 'area']) {
    assert.match(js, new RegExp(`'${type}'`), `${type} chart must be supported`);
  }
  assert.match(js, /norouter\.usageChart/);
  assert.match(html, /class="dtabs uchart-switch"[^>]*id="uChartTypes"/);
  assert.match(html, /class="dtab[^>]*"[^>]*id="usageChartHeatmap"/);
});

await test('all dashboard pages are served', async () => {
  for (const path of ['/map', '/providers', '/usage', '/chat', '/settings', '/api-keys', '/dashboard', '/providers/codebuddy-cn']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, `${path} should be 200`);
    assert.match(await res.text(), /norouter/, `${path} should serve the shell`);
  }
});

await test('managed API keys are plaintext, editable, and enforce /v1', async () => {
  const create = await fetch(`${base}/api/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Smoke client' }),
  });
  const created = await create.json();
  assert.equal(create.status, 201);
  assert.match(created.secret, /^nr_live_[A-Za-z0-9_-]+$/);
  assert.equal(created.key.enabled, true);
  assert.equal(created.key.secret, created.secret);
  assert.ok(!created.key.masked.includes(created.secret));

  const custom = await fetch(`${base}/api/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Custom client', secret: 'custom_smoke_key', requestLimit: 2, tokenLimit: '1M' }),
  });
  const customBody = await custom.json();
  assert.equal(custom.status, 201);
  assert.equal(customBody.secret, 'custom_smoke_key');
  assert.equal(customBody.key.requestLimit, 2);
  assert.equal(customBody.key.tokenLimit, 1_000_000);
  const billions = await fetch(`${base}/api/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Billion client', tokenLimit: '1B' }),
  });
  const billionsBody = await billions.json();
  assert.equal(billions.status, 201);
  assert.equal(billionsBody.key.tokenLimit, 1_000_000_000);

  const duplicate = await fetch(`${base}/api/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Duplicate client', secret: 'custom_smoke_key' }),
  });
  assert.equal(duplicate.status, 409);
  const expired = await fetch(`${base}/api/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Expired client', expiresAt: '2000-01-01' }),
  });
  assert.equal(expired.status, 400);

  const listed = await (await fetch(`${base}/api/keys`)).json();
  assert.equal(listed.keys.length, 3);
  assert.ok(JSON.stringify(listed).includes(created.secret));
  assert.ok(JSON.stringify(listed).includes('custom_smoke_key'));
  const history = await (await fetch(`${base}/api/keys/${customBody.key.id}/usage?days=7`)).json();
  assert.deepEqual(history.usage, []);

  const setting = await (await fetch(`${base}/api/auth-settings`)).json();
  assert.equal(setting.requireApiKey, false);
  const enabled = await fetch(`${base}/api/auth-settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requireApiKey: true }),
  });
  assert.equal(enabled.status, 200);
  assert.equal((await enabled.json()).requireApiKey, true);

  const unauthorized = await fetch(`${base}/v1/models`);
  assert.equal(unauthorized.status, 401);
  const authorized = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${created.secret}` } });
  assert.equal(authorized.status, 200);

  const updated = await fetch(`${base}/api/keys/${created.key.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Updated client', requestLimit: 7, tokenLimit: '2B' }),
  });
  const updatedBody = await updated.json();
  assert.equal(updated.status, 200);
  assert.equal(updatedBody.key.name, 'Updated client');
  assert.equal(updatedBody.key.requestLimit, 7);
  assert.equal(updatedBody.key.tokenLimit, 2_000_000_000);
  const replaced = await fetch(`${base}/api/keys/${created.key.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Updated client', secret: 'edited_smoke_key' }),
  });
  const replacedBody = await replaced.json();
  assert.equal(replaced.status, 200);
  assert.equal(replacedBody.key.secret, 'edited_smoke_key');
  const replacedToken = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer edited_smoke_key' } });
  assert.equal(replacedToken.status, 200);

  const rotate = await fetch(`${base}/api/keys/${created.key.id}/rotate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: 'rotated_smoke_key' }),
  });
  const rotated = await rotate.json();
  assert.equal(rotate.status, 200);
  assert.equal(rotated.key.id, created.key.id);
  assert.equal(rotated.secret, 'rotated_smoke_key');
  assert.ok(JSON.stringify(await (await fetch(`${base}/api/keys`)).json()).includes(rotated.secret));
  const oldToken = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer edited_smoke_key' } });
  assert.equal(oldToken.status, 401);
  const rotatedToken = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${rotated.secret}` } });
  assert.equal(rotatedToken.status, 200);

  const disabled = await fetch(`${base}/api/keys/${created.key.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(disabled.status, 200);
  const blocked = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${rotated.secret}` } });
  assert.equal(blocked.status, 401);

  const off = await fetch(`${base}/api/auth-settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requireApiKey: false }),
  });
  assert.equal(off.status, 200);
  const removed = await fetch(`${base}/api/keys/${created.key.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  const removedCustom = await fetch(`${base}/api/keys/${customBody.key.id}`, { method: 'DELETE' });
  assert.equal(removedCustom.status, 200);
  const removedBillions = await fetch(`${base}/api/keys/${billionsBody.key.id}`, { method: 'DELETE' });
  assert.equal(removedBillions.status, 200);
});

await test('provider detail reports pool, quota and models', async () => {
  const res = await fetch(`${base}/api/providers/codebuddy-cn`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.provider.id, 'codebuddy-cn');
  assert.equal(body.provider.credential, 'missing');
  assert.equal(body.provider.refreshSupported, true);
  assert.equal(body.provider.quotaSupported, true);
  assert.equal(body.pool.total, 0);
  assert.equal(typeof body.quota.used, 'number');
  const glm = body.models.find((m) => m.id === 'glm-5.3' && m.source === 'catalog');
  assert.ok(glm);
  assert.equal(glm.capabilities.reasoning.supported, true);
  assert.equal(glm.capabilities.limits.contextWindow, 1_000_000);
  assert.equal(glm.capabilities.limits.maxOutputTokens, 48_000);
  assert.equal(glm.capabilities.output.json.value, null);

  const missing = await fetch(`${base}/api/providers/nope`);
  assert.equal(missing.status, 404);
});

await test('Codex provider fetches its dedicated catalog endpoint', async () => {
  process.env.CODEX_BASE_URL = `${stubBase}/v2`;
  const created = await fetch(`${base}/api/providers/codex/accounts`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Codex catalog smoke', access_token: 'codex-catalog-token' }),
  });
  assert.equal(created.status, 201);
  try {
    const fetched = await fetch(`${base}/api/providers/codex/models/fetch`, { method: 'POST' });
    const body = await fetched.json();
    assert.equal(fetched.status, 200, JSON.stringify(body));
    assert.equal(body.url, `${stubBase}/v2/codex/models?client_version=0.159.0`);
    assert.ok(body.models.some((row) => row.id === 'gpt-stub-codex' && row.source === 'catalog'));
    assert.ok(body.models.some((row) => row.id === 'gpt-stub-fast' && row.source === 'catalog'));
    assert.equal(body.models.some((row) => row.id === 'gpt-stub-codex' && row.source === 'custom'), false);
    assert.ok(!JSON.stringify(body).includes('codex-catalog-token'));
  } finally {
    delete process.env.CODEX_BASE_URL;
    const pool = await (await fetch(`${base}/api/providers/codex/accounts?pageSize=200`)).json();
    for (const account of pool.items) {
      await fetch(`${base}/api/providers/codex/accounts/${account.id}`, { method: 'DELETE' });
    }
  }
});

await test('Codex catalog fetches every account and unions plan access', async () => {
  process.env.CODEX_BASE_URL = `${stubBase}/v2`;
  try {
    for (const [label, access_token] of [
      ['Codex Free catalog', 'codex-free-catalog-token'],
      ['Codex Plus catalog', 'codex-plus-catalog-token'],
    ]) {
      const created = await fetch(`${base}/api/providers/codex/accounts`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label, access_token }),
      });
      assert.equal(created.status, 201);
    }
    const fetched = await fetch(`${base}/api/providers/codex/models/fetch`, { method: 'POST' });
    const body = await fetched.json();
    assert.equal(fetched.status, 200, JSON.stringify(body));
    assert.equal(body.accounts.length, 2);
    assert.equal(body.partial, false);
    const models = new Map(body.models.map((model) => [model.id, model]));
    assert.deepEqual(models.get('gpt-stub-free').plans, ['free']);
    assert.deepEqual(models.get('gpt-stub-plus').plans, ['plus']);
    assert.deepEqual(models.get('gpt-stub-shared').plans, ['free', 'plus']);
  } finally {
    delete process.env.CODEX_BASE_URL;
    const pool = await (await fetch(`${base}/api/providers/codex/accounts?pageSize=200`)).json();
    for (const account of pool.items) await fetch(`${base}/api/providers/codex/accounts/${account.id}`, { method: 'DELETE' });
  }
});

await test('a streamed Responses tool call keeps its name and finish_reason', async () => {
  const state = createResponsesStreamState();
  const acc = createAccumulator();
  const item = { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Jakarta"}' };
  const events = [
    { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"city":' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"Jakarta"}' },
    { type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: item.arguments },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_1', output: [item] } },
  ];
  for (const event of events) {
    const mapped = fromResponsesStream(event, state);
    if (mapped.frame) acc.feed(mapped.frame);
  }
  const completion = acc.toCompletion('gpt-6-luna');
  const call = completion.choices[0].message.tool_calls[0];
  assert.equal(call.id, 'call_1');
  assert.equal(call.function.name, 'get_weather');
  assert.equal(call.function.arguments, item.arguments);
  assert.equal(completion.choices[0].finish_reason, 'tool_calls');
});

await test('parallel Responses tool calls keep separate indexes and full arguments', async () => {
  const state = createResponsesStreamState();
  const acc = createAccumulator();
  const items = [
    { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Jakarta"}' },
    { id: 'fc_2', type: 'function_call', call_id: 'call_2', name: 'get_time', arguments: '{"city":"Jakarta"}' },
  ];
  const indexes = [];
  const events = items.flatMap((item, index) => [
    { type: 'response.output_item.added', output_index: index, item: { ...item, arguments: '' } },
    { type: 'response.output_item.done', output_index: index, item },
  ]).concat({ type: 'response.completed', response: { id: 'resp_2', output: items } });
  for (const event of events) {
    const mapped = fromResponsesStream(event, state);
    if (!mapped.frame) continue;
    for (const call of mapped.frame.choices[0].delta.tool_calls || []) indexes.push(call.index);
    acc.feed(mapped.frame);
  }
  const calls = acc.toCompletion('gpt-6-luna').choices[0].message.tool_calls;
  assert.deepEqual(indexes, [0, 0, 1, 1]);
  assert.deepEqual(calls.map((call) => [call.id, call.function.name, call.function.arguments]), [
    ['call_1', 'get_weather', '{"city":"Jakarta"}'],
    ['call_2', 'get_time', '{"city":"Jakarta"}'],
  ]);
});

await test('Codex chat converts tool results to Responses items', async () => {
  process.env.CODEX_BASE_URL = `${stubBase}/v2`;
  probeShapes.length = 0;
  try {
    const created = await fetch(`${base}/api/providers/codex/accounts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Codex tools', access_token: 'codex-pro-token' }),
    });
    assert.equal(created.status, 201);
    const account = (await created.json()).items.find((row) => row.label === 'Codex tools');
    const { saveCodexAccountCatalog } = await import('../noroute_src/lib/codex-account.js');
    saveCodexAccountCatalog(account.id, 'pro', ['gpt-stub-codex']);
    const result = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'cx/gpt-stub-codex', stream: true,
        messages: [
          { role: 'user', content: 'Look up x' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] },
          { role: 'tool', tool_call_id: 'call_1', content: '{"value":42}' },
        ],
      }),
    });
    const body = await result.text();
    assert.equal(result.status, 200, body);
    assert.deepEqual(probeShapes, []);
  } finally {
    delete process.env.CODEX_BASE_URL;
    const pool = await (await fetch(`${base}/api/providers/codex/accounts?pageSize=200`)).json();
    for (const account of pool.items) await fetch(`${base}/api/providers/codex/accounts/${account.id}`, { method: 'DELETE' });
  }
});

await test('Codex keeps reasoning_effort through the Responses conversion', async () => {
  process.env.CODEX_BASE_URL = `${stubBase}/v2`;
  responsesBodies.length = 0;
  try {
    const created = await fetch(`${base}/api/providers/codex/accounts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Codex reasoning', access_token: 'codex-pro-token' }),
    });
    assert.equal(created.status, 201);
    const account = (await created.json()).items.find((row) => row.label === 'Codex reasoning');
    const { saveCodexAccountCatalog } = await import('../noroute_src/lib/codex-account.js');
    saveCodexAccountCatalog(account.id, 'pro', ['gpt-stub-codex']);
    const result = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'cx/gpt-stub-codex',
        stream: true,
        thinking: { type: 'enabled' },
        enable_thinking: true,
        reasoning_effort: 'high',
        reasoning: { effort: 'high' },
        messages: [{ role: 'user', content: 'think' }],
      }),
    });
    assert.equal(result.status, 200, await result.text());
    // Codex has no reasoning mapping, so mapReasoning must keep the canonical
    // reasoning_effort for toResponsesRequest to convert into reasoning.effort.
    const sent = responsesBodies.at(-1);
    assert.deepEqual(sent.reasoning, { effort: 'high' });
    assert.equal(sent.thinking, undefined);
    assert.equal(sent.enable_thinking, undefined);
    assert.equal(sent.messages, undefined);
  } finally {
    delete process.env.CODEX_BASE_URL;
    const pool = await (await fetch(`${base}/api/providers/codex/accounts?pageSize=200`)).json();
    for (const account of pool.items) await fetch(`${base}/api/providers/codex/accounts/${account.id}`, { method: 'DELETE' });
  }
});

await test('model test speaks Responses for a Codex OAuth account', async () => {
  process.env.CODEX_BASE_URL = `${stubBase}/v2`;
  probeShapes.length = 0;
  try {
    // Two accounts with different catalogs: the model is only reachable from
    // the second one, mirroring how plan tiers expose different models.
    for (const [label, token] of [['free', 'codex-free-token'], ['pro', 'codex-pro-token']]) {
      const created = await fetch(`${base}/api/providers/codex/accounts`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label, access_token: token }),
      });
      assert.equal(created.status, 201);
    }
    const pool = await (await fetch(`${base}/api/providers/codex/accounts?pageSize=200`)).json();
    const free = pool.items.find((row) => row.label === 'free');
    const pro = pool.items.find((row) => row.label === 'pro');
    const { saveCodexAccountCatalog } = await import('../noroute_src/lib/codex-account.js');
    saveCodexAccountCatalog(free.id, 'free', ['gpt-stub-codex']);
    saveCodexAccountCatalog(pro.id, 'pro', ['gpt-stub-codex', 'gpt-stub-pro-only']);

    const result = await fetch(`${base}/api/providers/codex/models/test`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-stub-pro-only' }),
    });
    const body = await result.json();
    assert.equal(result.status, 200, JSON.stringify(body));
    assert.equal(body.results[0].ok, true, JSON.stringify(body.results[0]));
    assert.match(body.results[0].answer, /gpt-stub-pro-only/);
    assert.equal(body.results[0].account.label, 'pro');
    // The probe reached the Responses route with `input`, never `messages`.
    assert.deepEqual(probeShapes, []);
  } finally {
    delete process.env.CODEX_BASE_URL;
    const pool = await (await fetch(`${base}/api/providers/codex/accounts?pageSize=200`)).json();
    for (const account of pool.items) {
      await fetch(`${base}/api/providers/codex/accounts/${account.id}`, { method: 'DELETE' });
    }
  }
});

await test('Codex model test distinguishes access from cooldown', async () => {
  process.env.CODEX_BASE_URL = `${stubBase}/v2`;
  try {
    const labels = ['Codex cooldown', 'Codex healthy'];
    for (const label of labels) {
      const created = await fetch(`${base}/api/providers/codex/accounts`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label, access_token: label.includes('healthy') ? 'codex-pro-token' : 'codex-free-token' }),
      });
      assert.equal(created.status, 201);
    }
    const pool = await (await fetch(`${base}/api/providers/codex/accounts?pageSize=200`)).json();
    const cooldown = pool.items.find((row) => row.label === 'Codex cooldown');
    const healthy = pool.items.find((row) => row.label === 'Codex healthy');
    const { saveCodexAccountCatalog } = await import('../noroute_src/lib/codex-account.js');
    saveCodexAccountCatalog(cooldown.id, 'free', ['gpt-stub-luna']);
    saveCodexAccountCatalog(healthy.id, 'pro', ['gpt-stub-luna']);
    const { cooldownAccount } = await import('../noroute_src/lib/accounts.js');
    cooldownAccount(cooldown.id, 60_000, 'Quota exhausted');
    const tested = await fetch(`${base}/api/providers/codex/models/test`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-stub-luna' }),
    });
    const body = await tested.json();
    assert.equal(tested.status, 200, JSON.stringify(body));
    assert.equal(body.results[0].ok, true);
    assert.equal(body.results[0].account.label, 'Codex healthy');
    cooldownAccount(healthy.id, 60_000, 'Quota exhausted');
    const blocked = await fetch(`${base}/api/providers/codex/models/test`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-stub-luna' }),
    });
    const blockedBody = await blocked.json();
    assert.equal(blocked.status, 409);
    assert.match(blockedBody.error.message, /rate-limited/i);
    for (const account of [cooldown, healthy]) {
      await fetch(`${base}/api/providers/codex/accounts/${account.id}`, { method: 'DELETE' });
    }
  } finally {
    delete process.env.CODEX_BASE_URL;
  }
});

await test('model test surfaces the real upstream 400 body', async () => {
  process.env.CODEX_BASE_URL = `${stubBase}/v2`;
  try {
    const created = await fetch(`${base}/api/providers/codex/accounts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Codex 400 body', access_token: 'codex-400-token' }),
    });
    const account = await created.json();
    assert.equal(created.status, 201);
    const { saveCodexAccountCatalog } = await import('../noroute_src/lib/codex-account.js');
    const row = account.items.find((item) => item.label === 'Codex 400 body');
    saveCodexAccountCatalog(row.id, 'pro', ['gpt-weird-error']);

    const res = await fetch(`${base}/api/providers/codex/models/test`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-weird-error', disableOnError: true }),
    });
    const body = await res.json();
    const first = body.results[0];
    assert.equal(first.ok, false);
    // The real reason must be visible, not the generic "failed with HTTP 400".
    assert.match(first.error, /Field required/);
    assert.ok(!/failed with HTTP 400\.$/.test(first.error), `generic fallback leaked: ${first.error}`);
    assert.match(first.upstreamBody, /Field required/);
    // A 400 is request-shaped: this healthy account must stay enabled.
    assert.equal(first.disabled, false);
    const after = await (await fetch(`${base}/api/providers/codex/accounts?pageSize=200`)).json();
    assert.equal(after.items.find((row) => row.label === 'Codex 400 body').enabled, true);
  } finally {
    delete process.env.CODEX_BASE_URL;
    const pool = await (await fetch(`${base}/api/providers/codex/accounts?pageSize=200`)).json();
    for (const account of pool.items) {
      await fetch(`${base}/api/providers/codex/accounts/${account.id}`, { method: 'DELETE' });
    }
  }
});

await test('Codex custom model ids are skipped instead of sent upstream', async () => {
  const id = `codex-local-${Date.now()}`;
  const add = await fetch(`${base}/api/providers/codex/models`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: id }),
  });
  assert.equal(add.status, 201);
  try {
    const tested = await fetch(`${base}/api/providers/codex/models/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: id }),
    });
    const body = await tested.json();
    assert.equal(tested.status, 200);
    assert.equal(body.results[0].skipped, true);
    assert.equal(body.failed, 0);
    assert.equal(stubCalls.includes(id), false);
  } finally {
    const removed = await fetch(`${base}/api/providers/codex/models/${encodeURIComponent(id)}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
  }
});

await test('custom model can be added, served and removed', async () => {
  const id = `test-model-${Date.now()}`;
  const add = await fetch(`${base}/api/providers/codebuddy-cn/models`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: id }),
  });
  const added = await add.json();
  try {
    assert.equal(add.status, 201);
    assert.ok(added.models.some((m) => m.id === id && m.source === 'custom'));
    assert.equal(resolveModel(`cbcn/${id}`).model, id);

    const catalog = await (await fetch(`${base}/v1/models`)).json();
    assert.ok(catalog.data.some((m) => m.id === `cbcn/${id}`));

    const duplicate = await fetch(`${base}/api/providers/codebuddy-cn/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: id }),
    });
    assert.equal(duplicate.status, 409);

    const invalid = await fetch(`${base}/api/providers/codebuddy-cn/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'bad model!' }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    const del = await fetch(`${base}/api/providers/codebuddy-cn/models/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    assert.equal(del.status, 200);
  }

  assert.ok(resolveModel(`cbcn/${id}`).error, 'removed model must stop resolving');
});

await test('models can be disabled and enabled without deleting them', async () => {
  const model = 'glm-5.3';
  const disabled = await fetch(`${base}/api/providers/codebuddy-cn/models/${model}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  const disabledBody = await disabled.json();
  assert.equal(disabled.status, 200, JSON.stringify(disabledBody));
  assert.equal(disabledBody.models.find((row) => row.id === model).enabled, false);
  const models = await (await fetch(`${base}/v1/models`)).json();
  assert.ok(!models.data.some((row) => row.id === `cbcn/${model}`));

  const enabled = await fetch(`${base}/api/providers/codebuddy-cn/models/${model}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  const enabledBody = await enabled.json();
  assert.equal(enabled.status, 200, JSON.stringify(enabledBody));
  assert.equal(enabledBody.models.find((row) => row.id === model).enabled, true);
});

await test('a disabled Codex model leaves /v1/models and survives a catalog refresh', async () => {
  process.env.CODEX_BASE_URL = `${stubBase}/v2`;
  const { saveCodexAccountCatalog } = await import('../noroute_src/lib/codex-account.js');
  const created = await fetch(`${base}/api/providers/codex/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Codex disabled smoke', access_token: 'codex-disabled-token' }),
  });
  assert.equal(created.status, 201);
  const account = (await created.json()).items.find((row) => row.label === 'Codex disabled smoke');
  saveCodexAccountCatalog(account.id, 'pro', ['gpt-stub-codex', 'gpt-stub-fast']);
  const setEnabled = (enabled) => fetch(`${base}/api/providers/codex/models/gpt-stub-codex`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  try {
    const before = await (await fetch(`${base}/v1/models`)).json();
    assert.ok(before.data.some((m) => m.id === 'cx/gpt-stub-codex'));

    assert.equal((await setEnabled(false)).status, 200);
    const after = await (await fetch(`${base}/v1/models`)).json();
    assert.ok(!after.data.some((m) => m.id === 'cx/gpt-stub-codex'), 'disabled codex model must leave /v1/models');
    assert.ok(after.data.some((m) => m.id === 'cx/gpt-stub-fast'), 'other codex models stay listed');
    assert.ok(resolveModel('cx/gpt-stub-codex').error, 'disabled codex model must stop resolving');
    assert.equal(resolveModel('cx/gpt-stub-fast').model, 'gpt-stub-fast');

    // A catalog refresh updates account access; it must not re-enable a model
    // the operator disabled.
    const refreshed = await fetch(`${base}/api/providers/codex/models/fetch`, { method: 'POST' });
    const refreshedBody = await refreshed.json();
    assert.equal(refreshed.status, 200, JSON.stringify(refreshedBody));
    const afterRefresh = await (await fetch(`${base}/v1/models`)).json();
    assert.ok(!afterRefresh.data.some((m) => m.id === 'cx/gpt-stub-codex'));

    assert.equal((await setEnabled(true)).status, 200);
    const restored = await (await fetch(`${base}/v1/models`)).json();
    assert.ok(restored.data.some((m) => m.id === 'cx/gpt-stub-codex'));
  } finally {
    await setEnabled(true);
    delete process.env.CODEX_BASE_URL;
    const pool = await (await fetch(`${base}/api/providers/codex/accounts?pageSize=200`)).json();
    for (const row of pool.items) await fetch(`${base}/api/providers/codex/accounts/${row.id}`, { method: 'DELETE' });
  }
});

await test('CodeBuddy model fetch is disabled because /models is unsupported', async () => {
  const res = await fetch(`${base}/api/providers/codebuddy-cn/models/fetch`, { method: 'POST' });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.match(body.error.message, /bundled model catalog/);
  assert.match(body.error.message, /\/models/);
});

await test('custom provider can be created, used and deleted', async () => {
  const id = `local-${Date.now()}`;
  const create = await fetch(`${base}/api/providers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `Local ${id}`,
      id,
      baseUrl: `${stubBase}/v2`,
      models: 'stub-model-a, stub-model-b',
    }),
  });
  const created = await create.json();
  try {
    assert.equal(create.status, 201);
    assert.equal(created.created, id);
    assert.equal(created.provider.id, id);
    assert.equal(created.provider.customProvider, true);
    assert.equal(created.provider.credential, 'open', 'open endpoint counts as ready');
    assert.equal(created.pool.total, 0);
    assert.equal(created.models.length, 2);

    // Empty catalogs are only valid from birth; a stray empty PATCH must not
    // wipe a provider that already routes models.
    const cleared = await fetch(`${base}/api/providers/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ models: [] }),
    });
    assert.equal(cleared.status, 400, 'clearing an existing catalog is rejected');

    assert.equal(resolveModel(`${id}/stub-model-a`).model, 'stub-model-a');
    const catalog = await (await fetch(`${base}/v1/models`)).json();
    assert.ok(catalog.data.some((m) => m.id === `${id}/stub-model-a`));

    // No credential variable, so the request must reach the upstream instead of
    // being stopped by the router. The stub itself rejects unauthenticated
    // calls, so only the router's own refusal is asserted here.
    const chat = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: `${id}/stub-model-a`, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const chatBody = await chat.json().catch(() => ({}));
    assert.doesNotMatch(
      chatBody.error?.message || '',
      /No credential for/,
      'open provider must not demand a credential',
    );

    // Custom providers follow the same visibility rule as bundled ones.
    const disabled = await fetch(`${base}/api/providers/${id}/models/stub-model-a`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(disabled.status, 200);
    const hidden = await (await fetch(`${base}/v1/models`)).json();
    assert.ok(!hidden.data.some((m) => m.id === `${id}/stub-model-a`), 'disabled model must leave /v1/models');
    assert.ok(hidden.data.some((m) => m.id === `${id}/stub-model-b`), 'other models stay listed');
    assert.ok(resolveModel(`${id}/stub-model-a`).error, 'disabled model must stop resolving');
    const enabled = await fetch(`${base}/api/providers/${id}/models/stub-model-a`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(enabled.status, 200);
  } finally {
    const del = await fetch(`${base}/api/providers/${id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
  }

  const gone = await fetch(`${base}/api/providers/${id}`);
  assert.equal(gone.status, 404);
});

await test('custom provider can be created without models, then get one from detail', async () => {
  const stamp = String(Date.now());
  const name = `Bare ${stamp}`;
  const prefix = `bare-${stamp.slice(-8)}`;
  const create = await fetch(`${base}/api/providers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Mirrors the dashboard create modal: name, prefix and endpoint only.
    body: JSON.stringify({ name, prefix, baseUrl: `${stubBase}/v2`, chatPath: '/chat/completions' }),
  });
  const created = await create.json();
  const id = created.created;
  try {
    assert.equal(create.status, 201, JSON.stringify(created));
    assert.ok(id);
    assert.equal(created.models.length, 0, 'models are optional at creation');

    // The edit form sends the full config without a models key when the
    // provider never had one, so saving other fields must stay possible.
    const edited = await fetch(`${base}/api/providers/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `${name} edited`, baseUrl: `${stubBase}/v2`, chatPath: '/chat/completions' }),
    });
    const editedBody = await edited.json();
    assert.equal(edited.status, 200, JSON.stringify(editedBody));
    assert.equal(editedBody.models.length, 0, 'a model-less provider stays editable');

    const added = await fetch(`${base}/api/providers/${id}/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-model-later' }),
    });
    const addedBody = await added.json();
    assert.equal(added.status, 201, JSON.stringify(addedBody));
    assert.ok(addedBody.models.some((model) => model.id === 'stub-model-later'));

    const catalog = await (await fetch(`${base}/v1/models`)).json();
    assert.ok(catalog.data.some((model) => model.id === `${created.provider.prefix}/stub-model-later`));
  } finally {
    await fetch(`${base}/api/providers/${id}`, { method: 'DELETE' });
  }
});

await test('custom provider formats default to the conventional chat path', async () => {
  const stamp = Date.now();
  const expected = { openai: '/chat/completions', responses: '/responses', anthropic: '/messages' };
  for (const [format, chatPath] of Object.entries(expected)) {
    const id = `preset-${format}-${stamp}`;
    const create = await fetch(`${base}/api/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: `Preset ${format}`,
        id,
        prefix: `pre-${format}-${String(stamp).slice(-6)}`,
        baseUrl: `${stubBase}/v2`,
        format,
      }),
    });
    const created = await create.json();
    try {
      assert.equal(create.status, 201, JSON.stringify(created));
      assert.equal(created.provider.format, format);
      assert.equal(created.provider.config.chatPath, chatPath, 'format alone picks its conventional endpoint');
    } finally {
      await fetch(`${base}/api/providers/${id}`, { method: 'DELETE' });
    }
  }

  // An explicit path wins over the preset; gateways commonly mount the API
  // under a version prefix.
  const customId = `preset-custom-${stamp}`;
  const custom = await fetch(`${base}/api/providers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `Preset custom ${stamp}`,
      id: customId,
      baseUrl: `${stubBase}/v2`,
      format: 'anthropic',
      chatPath: '/v1/messages',
    }),
  });
  const customBody = await custom.json();
  try {
    assert.equal(custom.status, 201, JSON.stringify(customBody));
    assert.equal(customBody.provider.config.chatPath, '/v1/messages');
  } finally {
    await fetch(`${base}/api/providers/${customId}`, { method: 'DELETE' });
  }

  const bad = await fetch(`${base}/api/providers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `Bad format ${stamp}`,
      id: `bad-format-${stamp}`,
      baseUrl: `${stubBase}/v2`,
      format: 'grpc',
    }),
  });
  const badBody = await bad.json();
  assert.equal(bad.status, 400);
  assert.match(badBody.error.message, /Format must be one of/);
});

// Reads the client-visible stream as raw text so the framing itself is checked:
// translated frames must be separated by real newlines and end in a real
// [DONE] sentinel, not a literal backslash-n.
async function collectChatStream(response) {
  const text = await response.text();
  assert.ok(
    text.endsWith('data: [DONE]\n\n'),
    `stream must end with a real [DONE] frame: ${JSON.stringify(text.slice(-40))}`,
  );
  assert.ok(!text.includes('\\n'), 'SSE frames must not contain literal backslash-n');
  const frames = [];
  for (const block of text.split('\n\n')) {
    const line = block.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    frames.push(JSON.parse(payload));
  }
  return frames;
}

await test('anthropic custom provider translates requests, responses and streams', async () => {
  const id = `anthropic-${Date.now()}`;
  const create = await fetch(`${base}/api/providers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `Anthropic ${id}`,
      id,
      baseUrl: `${stubBase}/v2`,
      format: 'anthropic',
      models: 'anthropic-plain, anthropic-tool, anthropic-thinking',
      requiresAccount: true,
    }),
  });
  const created = await create.json();
  assert.equal(create.status, 201, JSON.stringify(created));
  assert.equal(created.provider.format, 'anthropic');
  assert.equal(created.provider.config.chatPath, '/messages');
  const account = await fetch(`${base}/api/providers/${id}/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Anthropic account', access_token: 'anthropic-token' }),
  });
  assert.equal(account.status, 201, await account.text());
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: `${id}/anthropic-plain`,
        max_tokens: 300,
        temperature: 0.2,
        tools: [{
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Weather lookup',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        }],
        tool_choice: { type: 'function', function: { name: 'get_weather' } },
        messages: [
          { role: 'system', content: 'Be terse.' },
          { role: 'user', content: 'Weather in Jakarta?' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Jakarta"}' } }] },
          { role: 'tool', tool_call_id: 'call_1', content: '{"temp":30}' },
        ],
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.choices[0].message.content, 'I am the anthropic-plain model.');
    assert.equal(body.choices[0].finish_reason, 'stop');
    assert.deepEqual(body.usage, { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 });

    const upstream = anthropicBodies.at(-1);
    assert.ok(upstream.system.includes('Be terse.'), 'system messages move to the top-level system field');
    assert.equal(upstream.max_tokens, 300);
    assert.equal(upstream.temperature, 0.2);
    assert.equal(upstream.stream, false);
    assert.equal(upstream.reasoning_effort, undefined, 'OpenAI-only reasoning fields are not forwarded');
    assert.equal(upstream.stream_options, undefined);
    assert.ok(
      upstream.messages.every((message) => ['user', 'assistant'].includes(message.role)),
      'no system role may survive in messages',
    );
    const assistant = upstream.messages.find((message) => message.role === 'assistant');
    assert.equal(assistant.content[0].type, 'tool_use');
    assert.equal(assistant.content[0].id, 'call_1');
    assert.deepEqual(assistant.content[0].input, { city: 'Jakarta' });
    const toolTurn = upstream.messages.at(-1);
    assert.equal(toolTurn.role, 'user');
    assert.equal(toolTurn.content[0].type, 'tool_result');
    assert.equal(toolTurn.content[0].tool_use_id, 'call_1');
    assert.equal(toolTurn.content[0].content, '{"temp":30}');
    assert.equal(upstream.tools[0].name, 'get_weather');
    assert.equal(upstream.tools[0].input_schema.type, 'object');
    assert.deepEqual(upstream.tool_choice, { type: 'tool', name: 'get_weather' });

    // A tool-only answer becomes an OpenAI tool_calls message, not text.
    const toolRes = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: `${id}/anthropic-tool`,
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Weather?' }],
      }),
    });
    const toolBody = await toolRes.json();
    assert.equal(toolRes.status, 200, JSON.stringify(toolBody));
    assert.equal(toolBody.choices[0].message.content, null);
    assert.equal(toolBody.choices[0].finish_reason, 'tool_calls');
    assert.equal(toolBody.choices[0].message.tool_calls[0].function.name, 'get_weather');
    assert.deepEqual(
      JSON.parse(toolBody.choices[0].message.tool_calls[0].function.arguments),
      { city: 'Jakarta', unit: 'celsius' },
    );

    const streamRes = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: `${id}/anthropic-plain`,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(streamRes.status, 200);
    assert.match(streamRes.headers.get('content-type') || '', /text\/event-stream/);
    const frames = await collectChatStream(streamRes);
    assert.ok(frames.length > 1);
    assert.ok(
      frames.every((frame) => frame.object === 'chat.completion.chunk'),
      'Anthropic events must never leak to the client',
    );
    const streamed = frames.map((frame) => frame.choices?.[0]?.delta?.content || '').join('');
    assert.equal(streamed.trim(), 'I am the anthropic-plain model.');
    const finish = frames.at(-1);
    assert.equal(finish.choices[0].finish_reason, 'stop');
    assert.deepEqual(finish.usage, { prompt_tokens: 9, completion_tokens: 7, total_tokens: 16 });

    // Partial JSON argument fragments must merge into one valid call.
    const toolStream = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: `${id}/anthropic-tool`,
        stream: true,
        messages: [{ role: 'user', content: 'Weather?' }],
      }),
    });
    const toolFrames = await collectChatStream(toolStream);
    let toolName = '';
    let args = '';
    for (const frame of toolFrames) {
      const call = frame.choices?.[0]?.delta?.tool_calls?.[0];
      if (!call) continue;
      if (call.function?.name) toolName = call.function.name;
      if (call.function?.arguments) args += call.function.arguments;
    }
    assert.equal(toolName, 'get_weather');
    assert.deepEqual(JSON.parse(args), { city: 'Jakarta', unit: 'celsius' });
    assert.equal(toolFrames.at(-1).choices[0].finish_reason, 'tool_calls');

    // thinking_delta is surfaced as reasoning_content, like other providers.
    const thinkStream = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: `${id}/anthropic-thinking`,
        stream: true,
        messages: [{ role: 'user', content: 'think' }],
      }),
    });
    const thinkFrames = await collectChatStream(thinkStream);
    const reasoning = thinkFrames.map((frame) => frame.choices?.[0]?.delta?.reasoning_content || '').join('');
    assert.equal(reasoning.trim(), 'Let me think about it.');
    assert.equal(thinkFrames.at(-1).choices[0].finish_reason, 'stop');
  } finally {
    await fetch(`${base}/api/providers/${id}`, { method: 'DELETE' });
  }
});

await test('responses custom provider translates chat input and stream output', async () => {
  const id = `responses-${Date.now()}`;
  const create = await fetch(`${base}/api/providers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `Responses ${id}`,
      id,
      baseUrl: `${stubBase}/v2`,
      format: 'responses',
      models: 'responses-plain',
      requiresAccount: true,
    }),
  });
  const created = await create.json();
  assert.equal(create.status, 201, JSON.stringify(created));
  assert.equal(created.provider.format, 'responses');
  assert.equal(created.provider.config.chatPath, '/responses');
  const account = await fetch(`${base}/api/providers/${id}/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Responses account', access_token: 'responses-token' }),
  });
  assert.equal(account.status, 201, await account.text());
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: `${id}/responses-plain`,
        max_tokens: 128,
        tools: [{
          type: 'function',
          function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } },
        }],
        tool_choice: 'auto',
        messages: [
          { role: 'user', content: 'Weather in Jakarta?' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Jakarta"}' } }] },
          { role: 'tool', tool_call_id: 'call_1', content: '{"temp":30}' },
        ],
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.choices[0].message.content, 'I am the responses-plain Responses model.');
    assert.equal(body.choices[0].finish_reason, 'stop');
    assert.deepEqual(body.usage, { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });

    const upstream = responsesBodies.at(-1);
    assert.equal(upstream.store, false);
    assert.equal(upstream.messages, undefined, 'a chat body must never reach /responses');
    assert.ok(Array.isArray(upstream.input));
    const call = upstream.input.find((item) => item.type === 'function_call');
    assert.equal(call.call_id, 'call_1');
    assert.equal(call.name, 'get_weather');
    assert.equal(call.arguments, '{"city":"Jakarta"}');
    const output = upstream.input.find((item) => item.type === 'function_call_output');
    assert.equal(output.call_id, 'call_1');
    assert.equal(output.output, '{"temp":30}');
    assert.equal(upstream.tools[0].name, 'get_weather');
    assert.equal(upstream.tool_choice, 'auto');

    const streamRes = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: `${id}/responses-plain`,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(streamRes.status, 200);
    const frames = await collectChatStream(streamRes);
    assert.ok(frames.length > 1);
    assert.ok(
      frames.every((frame) => frame.object === 'chat.completion.chunk'),
      'Responses events must never leak to the client',
    );
    const streamed = frames.map((frame) => frame.choices?.[0]?.delta?.content || '').join('');
    assert.equal(streamed.trim(), 'I am the responses-plain Responses model.');
    assert.equal(frames.at(-1).choices[0].finish_reason, 'stop');
  } finally {
    await fetch(`${base}/api/providers/${id}`, { method: 'DELETE' });
  }
});

await test('non-stream responses provider buffers SSE into one completion', async () => {
  const id = `responses-buffered-${Date.now()}`;
  const create = await fetch(`${base}/api/providers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `Responses buffered ${id}`,
      id,
      baseUrl: `${stubBase}/v2`,
      format: 'responses',
      forceStream: true,
      models: 'responses-forced,responses-mislabeled',
      requiresAccount: true,
    }),
  });
  const created = await create.json();
  assert.equal(create.status, 201, JSON.stringify(created));
  const account = await fetch(`${base}/api/providers/${id}/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Buffered account', access_token: 'buffered-token' }),
  });
  assert.equal(account.status, 201, await account.text());
  try {
    const forced = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: `${id}/responses-forced`,
        stream: false,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    const forcedBody = await forced.json();
    assert.equal(forced.status, 200, JSON.stringify(forcedBody));
    assert.equal(forcedBody.choices[0].message.content.trim(), 'I am the responses-forced Responses model.');
    assert.equal(forcedBody.choices[0].finish_reason, 'stop');
    assert.equal(forcedBody.object, 'chat.completion');

    // The upstream ignored the Content-Type header convention; the body is
    // still an event stream and must not leak to the client as error text.
    const mislabeled = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: `${id}/responses-mislabeled`,
        stream: false,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    const mislabeledBody = await mislabeled.json();
    assert.equal(mislabeled.status, 200, JSON.stringify(mislabeledBody));
    assert.equal(mislabeledBody.choices[0].message.content, 'I am the responses-mislabeled Responses model.');
    assert.equal(mislabeledBody.choices[0].finish_reason, 'stop');
  } finally {
    await fetch(`${base}/api/providers/${id}`, { method: 'DELETE' });
  }
});


await test('reasoning levels map to provider params and history reasoning is stripped', async () => {
  const create = await fetch(`${base}/api/providers/codebuddy-cn/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Reasoning account', access_token: 'reasoning-token' }),
  });
  assert.equal(create.status, 201);
  const addModel = await fetch(`${base}/api/providers/codebuddy-cn/models`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'echo-reasoning' }),
  });
  assert.equal(addModel.status, 201);
  try {
    const high = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'cbcn/echo-reasoning',
        reasoning_effort: 'high',
        tools: [{ type: 'function', function: { name: 'run', parameters: { type: 'object' } } }],
        messages: [
          { role: 'assistant', content: 'old', reasoning_content: 'old chain of thought' },
          { role: 'user', content: 'new turn' },
        ],
      }),
    });
    const body = await high.json();
    assert.equal(high.status, 200, JSON.stringify(body));
    assert.equal(body.echoed.reasoning_effort, 'high');
    assert.equal(body.echoed.reasoning_summary, 'auto');
    assert.equal(body.echoed.tools.length, 1);
    // The default language=auto reply filter adds exactly one system message;
    // reasoning mapping itself must not add another, and history reasoning is
    // still stripped from the assistant turn.
    const systems = body.echoed.messages.filter((message) => message.role === 'system');
    assert.equal(systems.length, 1);
    assert.match(systems[0].content, /\[norouter reply style\]/);
    const assistant = body.echoed.messages.find((message) => message.role === 'assistant');
    assert.equal(assistant.reasoning_content, undefined);

    const saverOn = await fetch(`${base}/api/token-saver`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ponytail: { enabled: true } }) });
    assert.equal(saverOn.status, 200);
    const saverChat = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'cbcn/echo-reasoning', messages: body.echoed.messages }),
    });
    const saverBody = await saverChat.json();
    assert.equal(saverChat.status, 200, JSON.stringify(saverBody));
    const system = saverBody.echoed.messages.find((message) => message.role === 'system');
    assert.ok(system?.content.includes('[norouter token saver] Ponytail'));
    assert.equal(saverBody.echoed.messages.find((message) => message.role === 'user')?.content, 'new turn');
    assert.equal((system.content.match(/\[norouter token saver\]/g) || []).length, 1);
    const repeated = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'cbcn/echo-reasoning', messages: saverBody.echoed.messages }),
    });
    const repeatedBody = await repeated.json();
    const repeatedSystem = repeatedBody.echoed.messages.find((message) => message.role === 'system');
    assert.equal((repeatedSystem.content.match(/\[norouter token saver\]/g) || []).length, 1);
    const saverOff = await fetch(`${base}/api/token-saver`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ponytail: { enabled: false } }) });
    assert.equal(saverOff.status, 200);
    const offChat = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'cbcn/echo-reasoning', messages: [{ role: 'user', content: 'off stays unchanged' }] }),
    });
    const offChatBody = await offChat.json();
    assert.equal(offChat.status, 200, JSON.stringify(offChatBody));
    // Token Saver off must add no ponytail instruction; the user message stays
    // intact (the reply-filter auto system message may still be present).
    const offSystem = offChatBody.echoed.messages.find((message) => message.role === 'system');
    assert.doesNotMatch(offSystem?.content || '', /\[norouter token saver\]/);
    assert.equal(offChatBody.echoed.messages.find((message) => message.role === 'user')?.content, 'off stays unchanged');

    const nested = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'cbcn/echo-reasoning', thinking: { level: 'low' }, messages: [{ role: 'user', content: 'x' }] }),
    });
    const nestedBody = await nested.json();
    assert.equal(nestedBody.echoed.reasoning_effort, 'low');

    // ZCode sends every reasoning dialect at once. Only the provider's mapped
    // parameter may reach upstream; the alias fields must all be stripped.
    const zcode = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'cbcn/echo-reasoning',
        thinking: { type: 'enabled' },
        enable_thinking: true,
        reasoning_effort: 'high',
        reasoning: { effort: 'high' },
        messages: [{ role: 'user', content: 'zcode shape' }],
      }),
    });
    const zcodeBody = await zcode.json();
    assert.equal(zcode.status, 200, JSON.stringify(zcodeBody));
    assert.equal(zcodeBody.echoed.reasoning_effort, 'high');
    assert.equal(zcodeBody.echoed.reasoning_summary, 'auto');
    const zcodeUpstream = chatBodies.at(-1);
    assert.equal(zcodeUpstream.reasoning_effort, 'high');
    assert.equal(zcodeUpstream.reasoning_summary, 'auto');
    assert.equal(zcodeUpstream.thinking, undefined);
    assert.equal(zcodeUpstream.reasoning, undefined);
    assert.equal(zcodeUpstream.enable_thinking, undefined);

    // A provider without reasoning config has nothing to map, so the canonical
    // reasoning_effort is forwarded untouched while the aliases stay stripped.
    const plainId = `zcode-plain-${Date.now()}`;
    const plainCreate = await fetch(`${base}/api/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: `Plain ${plainId}`,
        id: plainId,
        baseUrl: `${stubBase}/v2`,
        models: 'echo-reasoning',
        requiresAccount: true,
      }),
    });
    assert.equal(plainCreate.status, 201, await plainCreate.text());
    const plainAccount = await fetch(`${base}/api/providers/${plainId}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Plain account', access_token: 'plain-token' }),
    });
    assert.equal(plainAccount.status, 201);
    try {
      const plain = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: `${plainId}/echo-reasoning`,
          thinking: { type: 'enabled' },
          enable_thinking: true,
          reasoning_effort: 'high',
          reasoning: { effort: 'high' },
          messages: [{ role: 'user', content: 'zcode shape' }],
        }),
      });
      const plainBody = await plain.json();
      assert.equal(plain.status, 200, JSON.stringify(plainBody));
      assert.equal(plainBody.echoed.reasoning_effort, 'high');
      assert.equal(plainBody.echoed.reasoning_summary, null);
      const plainUpstream = chatBodies.at(-1);
      assert.equal(plainUpstream.reasoning_effort, 'high');
      assert.equal(plainUpstream.thinking, undefined);
      assert.equal(plainUpstream.reasoning, undefined);
      assert.equal(plainUpstream.enable_thinking, undefined);

      // A saved config must reach the runtime provider, otherwise the field
      // would persist in SQLite but never change what is forwarded.
      const patch = await fetch(`${base}/api/providers/${plainId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          reasoning: {
            enabled: true,
            levels: ['low', 'medium', 'high'],
            mapping: { reasoning_effort: '$level' },
            defaultLevel: 'medium',
          },
        }),
      });
      assert.equal(patch.status, 200, await patch.text());
      const mapped = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: `${plainId}/echo-reasoning`,
          thinking: { type: 'enabled' },
          enable_thinking: true,
          reasoning_effort: 'high',
          reasoning: { effort: 'high' },
          messages: [{ role: 'user', content: 'zcode shape' }],
        }),
      });
      const mappedBody = await mapped.json();
      assert.equal(mapped.status, 200, JSON.stringify(mappedBody));
      assert.equal(mappedBody.echoed.reasoning_effort, 'high');
      const flagsOnly = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: `${plainId}/echo-reasoning`,
          thinking: { type: 'enabled' },
          enable_thinking: true,
          messages: [{ role: 'user', content: 'flags only' }],
        }),
      });
      const flagsOnlyBody = await flagsOnly.json();
      assert.equal(flagsOnly.status, 200, JSON.stringify(flagsOnlyBody));
      assert.equal(flagsOnlyBody.echoed.reasoning_effort, 'medium');
    } finally {
      await fetch(`${base}/api/providers/${plainId}`, { method: 'DELETE' });
    }

    const off = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'cbcn/echo-reasoning', reasoning_effort: 'none', messages: [{ role: 'user', content: 'x' }] }),
    });
    const offBody = await off.json();
    assert.equal(offBody.echoed.reasoning_effort, null);
    assert.equal(offBody.echoed.reasoning_summary, null);

    const invalid = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'cbcn/echo-reasoning', reasoning_effort: 'turbo', messages: [{ role: 'user', content: 'x' }] }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    const models = await (await fetch(`${base}/api/providers/codebuddy-cn`)).json();
    const row = models.models.find((item) => item.id === 'echo-reasoning');
    if (row) await fetch(`${base}/api/providers/codebuddy-cn/models/echo-reasoning`, { method: 'DELETE' });
    const account = (await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json()).items
      .find((item) => item.label === 'Reasoning account');
    if (account) await fetch(`${base}/api/providers/codebuddy-cn/accounts/${account.id}`, { method: 'DELETE' });
  }
});

await test('stream relay drops empty tool_calls arrays for any provider', async () => {
  const id = `stream-${Date.now()}`;
  const model = 'reasoning-empty-tools';
  // A custom provider proves the relay is provider-agnostic: the fix is not
  // keyed to CodeBuddy's id, model catalog, or reasoning config.
  const create = await fetch(`${base}/api/providers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `Stream ${id}`,
      id,
      baseUrl: `${stubBase}/v2`,
      models: model,
      requiresAccount: true,
    }),
  });
  assert.equal(create.status, 201, await create.clone().text());
  const account = await fetch(`${base}/api/providers/${id}/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Stream account', access_token: 'stream-token' }),
  });
  assert.equal(account.status, 201);
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: `${id}/${model}`,
        stream: true,
        messages: [{ role: 'user', content: 'think' }],
      }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);

    let reasoning = '';
    let content = '';
    let toolCall = null;
    for await (const event of readSSEEvents(res.body)) {
      const delta = event.data?.choices?.[0]?.delta;
      if (!delta) continue;
      assert.notDeepEqual(delta.tool_calls, [], 'empty tool_calls must not be relayed');
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
      if (typeof delta.content === 'string') content += delta.content;
      if (delta.tool_calls?.length) toolCall = delta.tool_calls[0];
    }
    assert.equal(reasoning, 'Think in one block.');
    assert.equal(content, 'Done.');
    assert.equal(toolCall?.function?.name, 'stub_tool', 'non-empty tool calls must still be relayed');
  } finally {
    const del = await fetch(`${base}/api/providers/${id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
  }
});

await test('/api/live streams request phases without account or prompt data', async () => {
  const id = `live-${Date.now()}`;
  const create = await fetch(`${base}/api/providers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `Live ${id}`,
      id,
      baseUrl: `${stubBase}/v2`,
      models: 'live-model',
      requiresAccount: true,
    }),
  });
  assert.equal(create.status, 201, await create.clone().text());
  const account = await fetch(`${base}/api/providers/${id}/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Live account', access_token: 'live-secret-token' }),
  });
  assert.equal(account.status, 201);

  const controller = new AbortController();
  const live = await fetch(`${base}/api/live`, { signal: controller.signal });
  assert.equal(live.status, 200);
  assert.match(live.headers.get('content-type') || '', /text\/event-stream/);

  const events = [];
  let settle;
  const arrived = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  const reader = (async () => {
    for await (const event of readSSEEvents(live.body)) {
      events.push(event.data);
      if (event.data?.phase === 'finish' || event.data?.phase === 'error') {
        settle.resolve();
        return;
      }
    }
    settle.resolve();
  })().catch((err) => {
    if (!controller.signal.aborted) settle.reject(err);
  });

  let deadline;
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: `${id}/live-model`,
        stream: true,
        messages: [{ role: 'user', content: 'live probe prompt' }],
      }),
    });
    assert.equal(res.status, 200);
    await res.text();

    const timeout = new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('live stream did not finish')), 10_000);
      deadline.unref?.();
    });
    await Promise.race([arrived, timeout]);

    assert.equal(events[0]?.phase, 'hello', 'the stream opens with a hello frame');
    assert.ok(Array.isArray(events[0].active), 'hello carries the in-flight allowlist');
    const phases = events.map((event) => event.phase);
    for (const phase of ['start', 'route', 'first', 'finish']) {
      assert.ok(phases.includes(phase), `missing ${phase} phase: ${phases.join(',')}`);
    }

    const start = events.find((event) => event.phase === 'start');
    assert.equal(start.kind, 'chat');
    assert.equal(start.stream, true);
    const route = events.find((event) => event.phase === 'route');
    assert.equal(route.provider, id);
    assert.equal(route.attempt, 1);
    const finish = events.find((event) => event.phase === 'finish');
    assert.equal(finish.provider, id);
    assert.equal(finish.status, 200);
    assert.equal(typeof finish.tokensIn, 'number');
    assert.equal(typeof finish.tokensOut, 'number');
    assert.ok(finish.ms >= 0);

    const raw = JSON.stringify(events);
    assert.doesNotMatch(raw, /"account"/, 'events must not carry account labels');
    assert.doesNotMatch(raw, /live-secret-token|Live account|live probe prompt/, 'events must not leak credentials or prompt text');
  } finally {
    clearTimeout(deadline);
    controller.abort();
    await reader;
    const del = await fetch(`${base}/api/providers/${id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
  }
});

await test('/api/live reports a model error without upstream message text', async () => {
  const controller = new AbortController();
  const live = await fetch(`${base}/api/live`, { signal: controller.signal });
  assert.equal(live.status, 200);

  const events = [];
  let settle;
  const arrived = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  const reader = (async () => {
    for await (const event of readSSEEvents(live.body)) {
      events.push(event.data);
      if (event.data?.phase === 'error') {
        settle.resolve();
        return;
      }
    }
    settle.resolve();
  })().catch((err) => {
    if (!controller.signal.aborted) settle.reject(err);
  });

  let deadline;
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: `missing-${Date.now()}`,
        messages: [{ role: 'user', content: 'secret probe prompt' }],
      }),
    });
    assert.equal(res.status, 400);
    await res.text();

    const timeout = new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('live error frame did not arrive')), 10_000);
      deadline.unref?.();
    });
    await Promise.race([arrived, timeout]);

    const start = events.find((event) => event.phase === 'start');
    assert.equal(start.kind, 'chat');
    const error = events.find((event) => event.phase === 'error');
    assert.equal(error.stage, 'model');
    assert.equal(error.status, 400);
    assert.equal(error.provider, undefined, 'a local model error has no provider yet');
    assert.doesNotMatch(JSON.stringify(events), /secret probe prompt|Unknown model|non-empty/);
  } finally {
    clearTimeout(deadline);
    controller.abort();
    await reader;
  }
});

await test('reasoning alias reaches stream and non-stream clients as reasoning_content', async () => {
  const id = `alias-${Date.now()}`;
  const model = 'reasoning-alias';
  // Upstage-style upstreams stream `delta.reasoning`; a custom provider proves
  // the normalization is not keyed to a built-in provider.
  const create = await fetch(`${base}/api/providers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `Alias ${id}`,
      id,
      baseUrl: `${stubBase}/v2`,
      models: model,
      requiresAccount: true,
    }),
  });
  assert.equal(create.status, 201, await create.clone().text());
  const account = await fetch(`${base}/api/providers/${id}/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Alias account', access_token: 'alias-token' }),
  });
  assert.equal(account.status, 201);
  try {
    const streamed = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: `${id}/${model}`,
        stream: true,
        messages: [{ role: 'user', content: 'think' }],
      }),
    });
    assert.equal(streamed.status, 200);
    let reasoning = '';
    let alias = '';
    let content = '';
    for await (const event of readSSEEvents(streamed.body)) {
      const delta = event.data?.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
      if (typeof delta.reasoning === 'string') alias += delta.reasoning;
      if (typeof delta.content === 'string') content += delta.content;
    }
    assert.equal(reasoning, 'Alias thought.', 'canonical reasoning_content must be relayed');
    assert.equal(alias, 'Alias thought.', 'the original alias must stay readable');
    assert.equal(content, 'Alias answer.');

    const plain = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: `${id}/${model}`,
        stream: false,
        messages: [{ role: 'user', content: 'think' }],
      }),
    });
    const body = await plain.json();
    assert.equal(plain.status, 200, JSON.stringify(body));
    assert.equal(body.choices[0].message.reasoning_content, 'Alias thought.');
    assert.equal(body.choices[0].message.reasoning, 'Alias thought.');
    assert.equal(body.choices[0].message.content, 'Alias answer.');
  } finally {
    const del = await fetch(`${base}/api/providers/${id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
  }
});

await test('provider PATCH persists config, reindexes prefix, and migrates data', async () => {
  const oldId = 'codebuddy-cn';
  const id = 'codebuddy-edited';
  const customModel = 'smoke-migrated-model';
  const accountToken = 'migrated-account-token';
  const addModel = await fetch(`${base}/api/providers/${oldId}/models`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: customModel }),
  });
  assert.equal(addModel.status, 201);
  const addAccount = await fetch(`${base}/api/providers/${oldId}/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Migrated account', access_token: accountToken }),
  });
  assert.equal(addAccount.status, 201);

  const patch = await fetch(`${base}/api/providers/${oldId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id,
      prefix: 'edited-cb',
      name: 'Edited CodeBuddy',
      website: 'https://example.test/provider',
      baseUrl: `${stubBase}/edited`,
      chatPath: '/chat/completions',
      headers: { 'X-Smoke-Provider': 'enabled' },
      models: ['edited-model'],
    }),
  });
  const patched = await patch.json();
  assert.equal(patch.status, 200, JSON.stringify(patched));
  assert.equal(patched.provider.id, id);
  assert.equal(patched.provider.prefix, 'edited-cb');
  assert.equal(patched.provider.config.prefix, 'edited-cb');
  assert.deepEqual(patched.provider.config.headers, { 'X-Smoke-Provider': 'enabled' });
  assert.equal((await fetch(`${base}/api/providers/${oldId}`)).status, 404);
  const detail = await (await fetch(`${base}/api/providers/${id}`)).json();
  assert.equal(detail.pool.total, 1);
  assert.ok(detail.models.some((model) => model.id === customModel && model.source === 'custom'));
  assert.equal(resolveModel(`edited-cb/${customModel}`).provider.id, id);
  assert.equal(resolveModel(`${id}/edited-model`).model, 'edited-model');

  const invalidHeader = await fetch(`${base}/api/providers/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ headers: { Authorization: 'Bearer never-store-this' } }),
  });
  const invalidBody = await invalidHeader.json();
  assert.equal(invalidHeader.status, 400);
  assert.ok(!JSON.stringify(invalidBody).includes('never-store-this'));

  const removeAccount = (await (await fetch(`${base}/api/providers/${id}/accounts?pageSize=20`)).json()).items
    .find((row) => row.label === 'Migrated account');
  await fetch(`${base}/api/providers/${id}/accounts/${removeAccount.id}`, { method: 'DELETE' });
  await fetch(`${base}/api/providers/${id}/models/${customModel}`, { method: 'DELETE' });
  const restore = await fetch(`${base}/api/providers/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: oldId,
      prefix: 'cbcn',
      name: 'CodeBuddy CN',
      website: 'https://copilot.tencent.com',
      baseUrl: 'https://copilot.tencent.com/v2',
      chatPath: '/chat/completions',
      headers: {
        'User-Agent': 'CLI/2.108.1 CodeBuddy/2.108.1',
        'X-Product': 'SaaS',
        'X-IDE-Type': 'CLI',
        'X-IDE-Name': 'CLI',
        'x-requested-with': 'XMLHttpRequest',
        'x-codebuddy-request': '1',
      },
      models: ['glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5.1', 'minimax-m3', 'hy3', 'hy4-preview', 'kimi-k3-1', 'kimi-k2.8-preview', 'deepseek-v4-pro', 'deepseek-v4.1-flash'],
    }),
  });
  assert.equal(restore.status, 200);
});

await test('shipped provider cannot be deleted from the API', async () => {
  const res = await fetch(`${base}/api/providers/codebuddy-cn`, { method: 'DELETE' });
  assert.equal(res.status, 400);
});

await test('invalid custom provider input is rejected', async () => {
  const cases = [
    { name: 'X', baseUrl: 'http://a', models: 'm' },
    { name: 'Bad Url', baseUrl: 'ftp://nope', models: 'm' },
    { name: 'Bad Model', baseUrl: 'http://127.0.0.1:1/v1', models: 'bad model!' },
    { name: 'Bad Env', baseUrl: 'http://127.0.0.1:1/v1', models: 'm', tokenEnv: 'lower case' },
  ];
  for (const payload of cases) {
    const res = await fetch(`${base}/api/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 400, `${JSON.stringify(payload)} should be rejected`);
  }
});

await test('provider account labels reuse the smallest gap and can be renamed', async () => {
  const provider = 'codebuddy-cn';
  for (;;) {
    const page = await (await fetch(`${base}/api/providers/${provider}/accounts?pageSize=200`)).json();
    if (!page.items.length) break;
    for (const row of page.items) await fetch(`${base}/api/providers/${provider}/accounts/${row.id}`, { method: 'DELETE' });
  }
  const create = async (token) => {
    const res = await fetch(`${base}/api/providers/${provider}/accounts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ access_token: token }),
    });
    assert.equal(res.status, 201);
    return (await res.json()).items.find((row) => row.hasAccessToken && row.masked.includes(token.slice(-4)));
  };
  const one = await create('label-gap-one');
  const two = await create('label-gap-two');
  const three = await create('label-gap-three');
  assert.deepEqual([one.label, two.label, three.label], ['cbcn_1', 'cbcn_2', 'cbcn_3']);
  await fetch(`${base}/api/providers/${provider}/accounts/${two.id}`, { method: 'DELETE' });
  const four = await create('label-gap-four');
  assert.equal(four.label, 'cbcn_2');

  const preview = await (await fetch(`${base}/api/providers/${provider}/accounts/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accounts: [{ access_token: 'label-preview-a' }, { access_token: 'label-preview-b' }] }),
  })).json();
  assert.deepEqual(preview.items.map((item) => item.label), ['cbcn_4', 'cbcn_5']);

  const renamed = await fetch(`${base}/api/providers/${provider}/accounts/${four.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Production backup' }),
  });
  const renamedBody = await renamed.json();
  assert.equal(renamed.status, 200);
  assert.equal(renamedBody.account.label, 'Production backup');
  assert.ok(!JSON.stringify(renamedBody).includes('label-gap-four'));

  for (const row of [one, three, four]) await fetch(`${base}/api/providers/${provider}/accounts/${row.id}`, { method: 'DELETE' });
});

await test('legacy automatic labels are normalized without touching custom names', () => {
  const provider = 'label-normalize-test';
  createAccount(provider, { access_token: 'normalize-a-123456', uid: 'uid-a', label: 'Account · uid-a' });
  createAccount(provider, { access_token: 'normalize-b-123456', uid: 'uid-b', label: 'Account · uid-b' });
  createAccount(provider, { access_token: 'normalize-c-123456', uid: 'uid-c', label: 'Production backup' });
  createAccount(provider, { access_token: 'normalize-d-123456', label: 'label-normalize-test_4' });
  createAccount(provider, { access_token: 'normalize-e-123456', label: 'ln_9' });

  // OAuth logins used to be saved as "ChatGPT OAuth"; with a provider that
  // declares OAuth those should follow the prefix like every other import.
  const oauthProvider = 'label-normalize-oauth';
  createAccount(oauthProvider, { access_token: 'normalize-f-123456', label: 'ChatGPT OAuth' });
  createAccount(oauthProvider, { access_token: 'normalize-g-123456', label: 'ChatGPT OAuth' });
  assert.equal(normalizeAutoAccountLabels([{ id: oauthProvider, prefix: 'oa', oauth: {} }]), 2);
  assert.deepEqual(
    listAccounts(oauthProvider, { pageSize: 100 }).items.map((row) => row.label),
    ['oa_1', 'oa_2'],
  );
  for (const row of listAccounts(oauthProvider, { pageSize: 100 }).items) deleteAccount(row.id);

  assert.equal(normalizeAutoAccountLabels([{ id: provider, prefix: 'ln' }]), 3);
  const expected = ['ln_1', 'ln_2', 'Production backup', 'ln_3', 'ln_9'];
  assert.deepEqual(listAccounts(provider, { pageSize: 100 }).items.map((row) => row.label), expected);

  // A second pass is a no-op: already-short names must not be renumbered.
  assert.equal(normalizeAutoAccountLabels([{ id: provider, prefix: 'ln' }]), 0);
  assert.deepEqual(listAccounts(provider, { pageSize: 100 }).items.map((row) => row.label), expected);

  for (const row of listAccounts(provider, { pageSize: 100 }).items) deleteAccount(row.id);
});

await test('account pool paginates, searches and masks tokens', () => {
  const provider = 'unit-test';
  for (let i = 0; i < 25; i += 1) {
    createAccount(provider, { access_token: `unit-token-${i}-abcdefgh` });
  }

  const first = listAccounts(provider, { page: 1, pageSize: 10 });
  assert.equal(first.total, 25);
  assert.equal(first.items.length, 10);
  assert.equal(first.pages, 3);
  assert.equal(first.counts.active, 25);
  assert.equal(first.items[0].masked, 'unit••••efgh');
  assert.ok(!JSON.stringify(first).includes('unit-token-0-abcdefgh'), 'raw token must not leak');
  assert.equal(first.items[0].hasAccessToken, true);

  const last = listAccounts(provider, { page: 3, pageSize: 10 });
  assert.equal(last.items.length, 5);

  const search = listAccounts(provider, { q: 'Account 1' });
  assert.equal(search.total, 0, 'custom provider labels use provider-prefixed defaults');

  const none = listAccounts(provider, { q: 'nothing-matches' });
  assert.equal(none.total, 0);

  for (const row of listAccounts(provider, { pageSize: 100 }).items) deleteAccount(row.id);
  assert.equal(listAccounts(provider).total, 0);
});

await test('account preview classifies duplicates without writing or leaking tokens', async () => {
  const provider = 'unit-preview';
  createAccount(provider, { label: 'Existing', access_token: 'preview-existing-secret-123456' });
  const entries = [
    { label: 'Existing again', access_token: 'preview-existing-secret-123456' },
    { label: 'Fresh', access_token: 'preview-fresh-secret-123456' },
    { label: 'Fresh duplicate', access_token: 'preview-fresh-secret-123456' },
    {},
  ];
  const preview = previewAccounts(provider, entries);
  assert.equal(preview.total, 4);
  assert.equal(preview.fresh, 1);
  assert.equal(preview.duplicates, 2);
  assert.equal(preview.invalid, 1);
  assert.deepEqual(preview.items.map((item) => item.status), ['duplicate', 'new', 'duplicate_input', 'invalid']);
  assert.equal(preview.items[0].masked, 'prev••••3456');
  assert.ok(!JSON.stringify(preview).includes('preview-existing-secret-123456'));
  assert.ok(!JSON.stringify(preview).includes('preview-fresh-secret-123456'));
  assert.equal(listAccounts(provider).total, 1, 'preview must not write rows');
  deleteAccount(listAccounts(provider).items[0].id);
});

await test('bulk import adds in one pass and skips duplicates', () => {
  const provider = 'unit-bulk';
  const entries = Array.from({ length: 40 }, (_, i) => ({ access_token: `bulk-${i}-xxxxxxxx` }));

  const created = bulkCreateAccounts(provider, entries);
  assert.equal(created.added, 40);
  assert.equal(created.duplicates, 0);

  const again = bulkCreateAccounts(provider, entries);
  assert.equal(again.added, 0);
  assert.equal(again.duplicates, 40);

  const mixed = bulkCreateAccounts(provider, [
    { access_token: 'bulk-new-xxxxxxxx' },
    {},
    { access_token: 'x'.repeat(9000) },
  ]);
  assert.equal(mixed.added, 1);
  assert.equal(mixed.invalid.length, 2);

  for (const row of listAccounts(provider, { pageSize: 200 }).items) deleteAccount(row.id);
});

await test('rotation walks the pool in order and wraps around', () => {
  const provider = 'unit-rr';
  for (const token of ['rr-one', 'rr-two', 'rr-three']) {
    createAccount(provider, { access_token: token });
  }

  const picked = [1, 2, 3, 4].map(() => pickAccount(provider)?.label);
  assert.deepEqual(picked, ['unit-rr_1', 'unit-rr_2', 'unit-rr_3', 'unit-rr_1']);

  for (const row of listAccounts(provider, { pageSize: 50 }).items) deleteAccount(row.id);
});

await test('sequential strategy reuses the first healthy account', () => {
  const provider = 'unit-seq';
  for (const token of ['seq-one', 'seq-two', 'seq-three']) {
    createAccount(provider, { access_token: token });
  }

  const picked = [1, 2, 3].map(() => pickAccount(provider, 'sequential')?.label);
  assert.deepEqual(picked, ['unit-seq_1', 'unit-seq_1', 'unit-seq_1']);
  // An unknown strategy falls back to round-robin rather than breaking routing.
  assert.equal(pickAccount(provider, 'not-a-strategy')?.label, 'unit-seq_1');
  assert.equal(pickAccount(provider, 'not-a-strategy')?.label, 'unit-seq_2');

  for (const row of listAccounts(provider, { pageSize: 50 }).items) deleteAccount(row.id);
});

await test('highest-quota strategy picks the account with the most headroom', async () => {
  for (;;) {
    const page = await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json();
    if (!page.items.length) break;
    for (const row of page.items) {
      await fetch(`${base}/api/providers/codebuddy-cn/accounts/${row.id}`, { method: 'DELETE' });
    }
  }
  const create = async (label, token) => {
    const res = await fetch(`${base}/api/providers/codebuddy-cn/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label, access_token: token }),
    });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    return body.items.find((row) => row.label === label);
  };
  const low = await create('Low headroom', 'low-quota-token');
  const high = await create('High headroom', 'high-quota-token');
  for (const account of [low, high]) {
    const quota = await fetch(`${base}/api/providers/codebuddy-cn/accounts/${account.id}/quota`, { method: 'POST' });
    assert.equal(quota.status, 200);
  }

  // Pool order would pick "Low headroom" first; the strategy must not.
  assert.equal(pickAccount('codebuddy-cn', 'highest-quota')?.label, 'High headroom');
  assert.equal(pickAccount('codebuddy-cn', 'sequential')?.label, 'Low headroom');

  for (const account of [low, high]) {
    await fetch(`${base}/api/providers/codebuddy-cn/accounts/${account.id}`, { method: 'DELETE' });
  }
});

await test('provider account strategy persists through PATCH and rejects unknown values', async () => {
  const invalid = await fetch(`${base}/api/providers/codebuddy-cn`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountStrategy: 'random-luck' }),
  });
  const invalidBody = await invalid.json();
  assert.equal(invalid.status, 400);
  assert.match(invalidBody.error?.message || '', /accountStrategy must be one of/);

  const detail = await (await fetch(`${base}/api/providers/codebuddy-cn`)).json();
  assert.equal(detail.provider.config.accountStrategy, 'round-robin');

  const valid = await fetch(`${base}/api/providers/codebuddy-cn`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountStrategy: 'sequential' }),
  });
  const validBody = await valid.json();
  assert.equal(valid.status, 200, JSON.stringify(validBody));
  assert.equal(validBody.provider.config.accountStrategy, 'sequential');

  const reloaded = await (await fetch(`${base}/api/providers/codebuddy-cn`)).json();
  assert.equal(reloaded.provider.config.accountStrategy, 'sequential', 'strategy must survive a reload');

  const restore = await fetch(`${base}/api/providers/codebuddy-cn`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountStrategy: 'round-robin' }),
  });
  assert.equal(restore.status, 200);
});

await test('chat routing follows the provider account strategy', async () => {
  for (;;) {
    const page = await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json();
    if (!page.items.length) break;
    for (const row of page.items) {
      await fetch(`${base}/api/providers/codebuddy-cn/accounts/${row.id}`, { method: 'DELETE' });
    }
  }
  for (const token of ['strategy-one', 'strategy-two']) {
    const res = await fetch(`${base}/api/providers/codebuddy-cn/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ access_token: token }),
    });
    assert.equal(res.status, 201);
  }

  const setStrategy = async (value) => {
    const res = await fetch(`${base}/api/providers/codebuddy-cn`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountStrategy: value }),
    });
    assert.equal(res.status, 200);
  };
  const send = async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'cbcn/glm-5.3',
        messages: [{ role: 'user', content: 'strategy smoke' }],
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
  };
  const pool = async () => (await (await fetch(
    `${base}/api/providers/codebuddy-cn/accounts?pageSize=200`,
  )).json()).items;

  await setStrategy('sequential');
  await send();
  await send();
  let rows = await pool();
  assert.equal(rows.find((row) => row.label === 'cbcn_1').requests, 2, 'sequential must keep the first account');
  assert.equal(rows.find((row) => row.label === 'cbcn_2').requests, 0);

  await setStrategy('round-robin');
  // The round-robin cursor starts at the first account, so two requests touch
  // both accounts regardless of which one the previous strategy left on.
  await send();
  await send();
  rows = await pool();
  assert.equal(rows.find((row) => row.label === 'cbcn_1').requests, 3);
  assert.equal(rows.find((row) => row.label === 'cbcn_2').requests, 1, 'round-robin must move to the next account');

  await setStrategy('round-robin');
  for (const row of await pool()) {
    await fetch(`${base}/api/providers/codebuddy-cn/accounts/${row.id}`, { method: 'DELETE' });
  }
});

await test('account preview API never writes or returns raw credentials', async () => {
  const create = await fetch(`${base}/api/providers/codebuddy-cn/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Preview existing', access_token: 'preview-http-secret-123456' }),
  });
  assert.equal(create.status, 201);
  const before = (await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json()).total;
  const preview = await fetch(`${base}/api/providers/codebuddy-cn/accounts/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accounts: [
      { access_token: 'preview-http-secret-123456' },
      { access_token: 'preview-http-fresh-123456' },
    ] }),
  });
  const body = await preview.json();
  assert.equal(preview.status, 200);
  assert.equal(body.duplicates, 1);
  assert.equal(body.fresh, 1);
  assert.ok(!JSON.stringify(body).includes('preview-http-secret-123456'));
  assert.ok(!JSON.stringify(body).includes('preview-http-fresh-123456'));
  const after = (await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json()).total;
  assert.equal(after, before, 'preview endpoint must not write rows');
  const row = (await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json()).items.find((item) => item.label === 'Preview existing');
  await fetch(`${base}/api/providers/codebuddy-cn/accounts/${row.id}`, { method: 'DELETE' });
});

await test('account CRUD over HTTP never returns the raw token', async () => {
  const create = await fetch(`${base}/api/providers/codebuddy-cn/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'HTTP account', access_token: 'http-token-1234567890' }),
  });
  const created = await create.json();
  assert.equal(create.status, 201);
  assert.equal(created.added, 1);
  assert.ok(!JSON.stringify(created).includes('http-token-1234567890'));

  const account = created.items.find((row) => row.label === 'HTTP account');
  assert.ok(account, 'created account must appear on page one');
  assert.equal(account.status, 'active');

  const duplicate = await fetch(`${base}/api/providers/codebuddy-cn/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ access_token: 'http-token-1234567890' }),
  });
  assert.equal(duplicate.status, 409);

  const paused = await fetch(`${base}/api/providers/codebuddy-cn/accounts/${account.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  const pausedBody = await paused.json();
  assert.equal(paused.status, 200);
  assert.equal(pausedBody.account.enabled, false);

  const disabledOnly = await (await fetch(
    `${base}/api/providers/codebuddy-cn/accounts?status=disabled`,
  )).json();
  assert.equal(disabledOnly.total, 1);

  const removed = await fetch(`${base}/api/providers/codebuddy-cn/accounts/${account.id}`, {
    method: 'DELETE',
  });
  assert.equal(removed.status, 200);
  assert.equal(getAccount(account.id), null);

  const bulk = await fetch(`${base}/api/providers/codebuddy-cn/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accounts: [{ access_token: 'bulk-http-1-xxxxxxxx' }, { access_token: 'bulk-http-2-xxxxxxxx' }] }),
  });
  const bulkBody = await bulk.json();
  assert.equal(bulk.status, 201);
  assert.equal(bulkBody.added, 2);
});

await test('model tests use active accounts and support disable-on-error', async () => {
  for (;;) {
    const page = await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json();
    if (!page.items.length) break;
    for (const row of page.items) {
      await fetch(`${base}/api/providers/codebuddy-cn/accounts/${row.id}`, { method: 'DELETE' });
    }
  }

  for (const token of ['model-good-a', 'model-good-b']) {
    const created = await fetch(`${base}/api/providers/codebuddy-cn/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ access_token: token }),
    });
    assert.equal(created.status, 201);
  }

  const pass = await fetch(`${base}/api/providers/codebuddy-cn/models/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.3' }),
  });
  const passBody = await pass.json();
  assert.equal(pass.status, 200, JSON.stringify(passBody));
  assert.equal(passBody.passed, 1);
  assert.equal(passBody.results[0].ok, true);
  assert.match(passBody.results[0].answer, /I am the glm-5\.3 model/);
  assert.ok(passBody.results[0].latencyMs >= 0);
  assert.ok(passBody.results[0].account.label);
  assert.ok(!JSON.stringify(passBody).includes('model-good-a'));
  assert.ok(!JSON.stringify(passBody).includes('model-good-b'));

  const probe = await fetch(`${base}/api/providers/codebuddy-cn/models/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.3-flash' }),
  });
  const probeBody = await probe.json();
  assert.equal(probe.status, 200);
  assert.equal(probeBody.failed, 1);
  assert.equal(probeBody.results[0].ok, false);
  assert.equal(probeBody.results[0].answer, undefined);

  let pool = await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json();
  assert.equal(pool.counts.active, 2, 'test-only errors must not disable an account');

  const all = await fetch(`${base}/api/providers/codebuddy-cn/models/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ all: true, disableOnError: true }),
  });
  const allBody = await all.json();
  assert.equal(all.status, 200, JSON.stringify(allBody));
  assert.equal(allBody.tested, 11);
  assert.equal(allBody.passed, 10);
  assert.equal(allBody.failed, 1);
  assert.equal(allBody.results.find((row) => row.model === 'glm-5.3-flash').disabled, true);

  pool = await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json();
  assert.equal(pool.counts.disabled, 1);

  for (const row of pool.items) {
    if (row.enabled) {
      const paused = await fetch(`${base}/api/providers/codebuddy-cn/accounts/${row.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      assert.equal(paused.status, 200);
    }
  }

  const none = await fetch(`${base}/api/providers/codebuddy-cn/models/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.3' }),
  });
  const noneBody = await none.json();
  assert.equal(none.status, 409);
  assert.match(noneBody.error.message, /active account/i);
});

await test('Codex WHAM quota is fetched, parsed and stored on the account', async () => {
  process.env.CODEX_QUOTA_URL = `${stubBase}/wham/usage`;
  const create = await fetch(`${base}/api/providers/codex/accounts`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Codex quota smoke', access_token: 'codex-pro-quota-token' }),
  });
  assert.equal(create.status, 201);
  const created = await create.json();
  const account = created.items.find((row) => row.label === 'Codex quota smoke');
  try {
    const response = await fetch(`${base}/api/providers/codex/accounts/${account.id}/quota`, { method: 'POST' });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.quota.plan, 'pro');
    assert.equal(body.quota.quotas.session.used, 18);
    assert.equal(body.quota.quotas.weekly.used, 42);
    const listed = await (await fetch(`${base}/api/providers/codex/accounts?pageSize=200`)).json();
    assert.equal(listed.items.find((row) => row.id === account.id).plan, 'pro');
  } finally {
    await fetch(`${base}/api/providers/codex/accounts/${account.id}`, { method: 'DELETE' });
    delete process.env.CODEX_QUOTA_URL;
  }
});

await test('Codex exhausted quota parks the account in cooldown', async () => {
  process.env.CODEX_QUOTA_URL = `${stubBase}/wham/usage`;
  const create = await fetch(`${base}/api/providers/codex/accounts`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Codex exhausted quota', access_token: 'codex-exhausted-quota-token' }),
  });
  const created = await create.json();
  assert.equal(create.status, 201);
  const account = created.items.find((row) => row.label === 'Codex exhausted quota');
  try {
    const response = await fetch(`${base}/api/providers/codex/accounts/${account.id}/quota`, { method: 'POST' });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.quota.quotas.session.used, 100);
    const listed = await (await fetch(`${base}/api/providers/codex/accounts?pageSize=200`)).json();
    const parked = listed.items.find((row) => row.id === account.id);
    assert.equal(parked.status, 'cooldown');
    assert.match(parked.lastError, /Quota exhausted/);
    assert.ok(parked.cooldownUntil > Date.now());
  } finally {
    await fetch(`${base}/api/providers/codex/accounts/${account.id}`, { method: 'DELETE' });
    delete process.env.CODEX_QUOTA_URL;
  }
});

await test('refresh token is exchanged and real quota is read', async () => {
  const create = await fetch(`${base}/api/providers/codebuddy-cn/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Refresh account', kind: 'refresh_token', refresh_token: 'refresh-ok' }),
  });
  const created = await create.json();
  assert.equal(create.status, 201);

  const account = created.items.find((row) => row.label === 'Refresh account');
  assert.equal(account.hasAccessToken, false);
  assert.equal(account.hasRefreshToken, true);

  const tested = await fetch(`${base}/api/providers/codebuddy-cn/accounts/${account.id}/test`, {
    method: 'POST',
  });
  const result = await tested.json();
  assert.equal(tested.status, 200, JSON.stringify(result));
  assert.equal(result.account.hasAccessToken, true, 'refresh must store the new access token');
  assert.equal(result.quota.used, 120);
  assert.equal(result.quota.total, 500);
  assert.equal(result.quota.packages[0].name, 'Monthly');
  assert.equal(result.quota.packages[0].recurring, true);

  const quota = await fetch(`${base}/api/providers/codebuddy-cn/accounts/${account.id}/quota`, {
    method: 'POST',
  });
  const quotaBody = await quota.json();
  assert.equal(quota.status, 200);
  assert.equal(quotaBody.quota.total, 500);
});

await test('global quota list ranks quota accounts before empty accounts', async () => {
  for (;;) {
    const page = await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json();
    if (!page.items.length) break;
    for (const account of page.items) {
      await fetch(`${base}/api/providers/codebuddy-cn/accounts/${account.id}`, { method: 'DELETE' });
    }
  }
  const create = async (label, token) => {
    const res = await fetch(`${base}/api/providers/codebuddy-cn/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label, access_token: token }),
    });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    return body.items.find((row) => row.label === label);
  };
  const empty = await create('Quota empty', 'empty-quota-token');
  const full = await create('Quota full', 'full-quota-token');
  for (const account of [empty, full]) {
    const quota = await fetch(`${base}/api/providers/codebuddy-cn/accounts/${account.id}/quota`, { method: 'POST' });
    assert.equal(quota.status, 200);
  }
  const list = await fetch(`${base}/api/providers/codebuddy-cn/accounts/quota-list?page=1&pageSize=5`);
  const listBody = await list.json();
  assert.equal(list.status, 200);
  const fullIndex = listBody.items.findIndex((row) => row.label === 'Quota full');
  const emptyIndex = listBody.items.findIndex((row) => row.label === 'Quota empty');
  assert.ok(fullIndex >= 0 && emptyIndex >= 0 && fullIndex < emptyIndex);
  assert.ok(!JSON.stringify(listBody).includes('full-quota-token'));

  const refreshed = await fetch(`${base}/api/providers/codebuddy-cn/accounts/quota-order/refresh`, { method: 'POST' });
  const refreshedBody = await refreshed.json();
  assert.equal(refreshed.status, 200);
  assert.ok(refreshedBody.withQuota >= 1);
  assert.ok(refreshedBody.empty >= 1);
  for (const account of [empty, full]) {
    await fetch(`${base}/api/providers/codebuddy-cn/accounts/${account.id}`, { method: 'DELETE' });
  }
});

await test('daily check-in uses OAuth tokens, handles already, and rejects API keys locally', async () => {
  const jwt = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"checkin-user"}').toString('base64url')}.signature`;
  const create = async (label, input) => {
    const res = await fetch(`${base}/api/providers/codebuddy-cn/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label, ...input }),
    });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    return body.items.find((row) => row.label === label);
  };

  const oauth = await create('Check-in OAuth', { access_token: jwt, uid: 'fallback-id' });
  const ok = await fetch(`${base}/api/providers/codebuddy-cn/accounts/${oauth.id}/checkin`, { method: 'POST' });
  const okBody = await ok.json();
  assert.equal(ok.status, 200, JSON.stringify(okBody));
  assert.equal(okBody.checkin.status, 'checked-in');
  assert.equal(okBody.account.requests, 0, 'check-in must not count as a proxied request');
  assert.ok(!JSON.stringify(okBody).includes(jwt), 'check-in response must not leak token');

  const already = await create('Check-in already', { access_token: 'already-token', uid: 'checkin-user' });
  const again = await fetch(`${base}/api/providers/codebuddy-cn/accounts/${already.id}/checkin`, { method: 'POST' });
  const againBody = await again.json();
  assert.equal(again.status, 200, JSON.stringify(againBody));
  assert.equal(againBody.checkin.status, 'already');

  const apiKey = await create('Check-in API key', { kind: 'api_key', api_key: 'sk-checkin-local-only' });
  const rejected = await fetch(`${base}/api/providers/codebuddy-cn/accounts/${apiKey.id}/checkin`, { method: 'POST' });
  const rejectedBody = await rejected.json();
  assert.equal(rejected.status, 400);
  assert.match(rejectedBody.error.message, /OAuth access token/);
  assert.ok(!JSON.stringify(rejectedBody).includes('sk-checkin-local-only'));

  for (const account of [oauth, already, apiKey]) {
    await fetch(`${base}/api/providers/codebuddy-cn/accounts/${account.id}`, { method: 'DELETE' });
  }
});

await test('check-in all sweeps the pool and skips API keys and paused accounts', async () => {
  for (;;) {
    const page = await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json();
    if (!page.items.length) break;
    for (const row of page.items) await fetch(`${base}/api/providers/codebuddy-cn/accounts/${row.id}`, { method: 'DELETE' });
  }
  const create = async (label, input) => {
    const res = await fetch(`${base}/api/providers/codebuddy-cn/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label, ...input }),
    });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    return body.items.find((row) => row.label === label);
  };

  const oauth = await create('Check-in all oauth', { access_token: 'good-token', uid: 'checkin-all-oauth' });
  const already = await create('Check-in all already', { access_token: 'already-token', uid: 'checkin-all-already' });
  const apiKey = await create('Check-in all api key', { kind: 'api_key', api_key: 'sk-checkin-all-local' });
  const paused = await create('Check-in all paused', { access_token: 'paused-checkin-token' });
  const pause = await fetch(`${base}/api/providers/codebuddy-cn/accounts/${paused.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(pause.status, 200, JSON.stringify(await pause.json()));

  const response = await fetch(`${base}/api/providers/codebuddy-cn/accounts/checkin`, { method: 'POST' });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.provider, 'codebuddy-cn');
  assert.equal(body.attempted, 2, 'only enabled OAuth accounts are attempted');
  assert.equal(body.checkedIn, 1);
  assert.equal(body.already, 1);
  assert.equal(body.failed, 0);
  assert.equal(body.skipped, 2, 'API key and paused accounts are skipped, not failed');
  assert.ok(body.results.every((row) => !('accountId' in row)), 'results must not carry internal IDs');
  assert.ok(!JSON.stringify(body).includes('good-token'), 'check-in all must not leak tokens');

  for (const account of [oauth, already, apiKey, paused]) {
    await fetch(`${base}/api/providers/codebuddy-cn/accounts/${account.id}`, { method: 'DELETE' });
  }
});

await test('account ping answers one real chat turn and reports missing or paused accounts safely', async () => {
  for (;;) {
    const page = await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json();
    if (!page.items.length) break;
    for (const row of page.items) await fetch(`${base}/api/providers/codebuddy-cn/accounts/${row.id}`, { method: 'DELETE' });
  }
  const create = async (label, input) => {
    const res = await fetch(`${base}/api/providers/codebuddy-cn/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label, ...input }),
    });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    return body.items.find((row) => row.label === label);
  };

  const good = await create('Ping good', { access_token: 'good-token' });
  const paused = await create('Ping paused', { access_token: 'paused-ping-token' });
  const pause = await fetch(`${base}/api/providers/codebuddy-cn/accounts/${paused.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(pause.status, 200, JSON.stringify(await pause.json()));

  const ok = await fetch(`${base}/api/providers/codebuddy-cn/accounts/${good.id}/ping`, { method: 'POST' });
  const okBody = await ok.json();
  assert.equal(ok.status, 200, JSON.stringify(okBody));
  assert.equal(okBody.ok, true);
  assert.equal(okBody.state, 'active');
  assert.ok(typeof okBody.answer === 'string' && okBody.answer.length > 0, 'ping must return the upstream answer');
  assert.equal(okBody.account.label, 'Ping good');
  assert.ok(!JSON.stringify(okBody).includes('good-token'), 'ping must not leak tokens');

  const pausedRes = await fetch(`${base}/api/providers/codebuddy-cn/accounts/${paused.id}/ping`, { method: 'POST' });
  const pausedBody = await pausedRes.json();
  assert.equal(pausedRes.status, 409, JSON.stringify(pausedBody));
  assert.match(pausedBody.error.message, /paused/);
  assert.ok(!JSON.stringify(pausedBody).includes('good-token'));

  const missing = await fetch(`${base}/api/providers/codebuddy-cn/accounts/does-not-exist/ping`, { method: 'POST' });
  assert.equal(missing.status, 404);

  for (const account of [good, paused]) {
    await fetch(`${base}/api/providers/codebuddy-cn/accounts/${account.id}`, { method: 'DELETE' });
  }
});

await test('a rate-limited account cools down and the next account serves', async () => {
  // Start from an empty pool so rotation order is deterministic.
  for (;;) {
    const page = await (await fetch(
      `${base}/api/providers/codebuddy-cn/accounts?pageSize=200`,
    )).json();
    if (!page.items.length) break;
    for (const row of page.items) {
      await fetch(`${base}/api/providers/codebuddy-cn/accounts/${row.id}`, { method: 'DELETE' });
    }
  }

  for (const token of ['limited-token', 'good-token']) {
    const res = await fetch(`${base}/api/providers/codebuddy-cn/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ access_token: token }),
    });
    assert.equal(res.status, 201);
  }

  const chat = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'cbcn/glm-5.3',
      messages: [{ role: 'user', content: 'halo' }],
    }),
  });
  const body = await chat.json();
  assert.equal(chat.status, 200, JSON.stringify(body));
  assert.match(body.choices[0].message.content, /stub reply/);

  const pool = await (await fetch(
    `${base}/api/providers/codebuddy-cn/accounts?pageSize=200`,
  )).json();
  const limited = pool.items.find((row) => row.label === 'cbcn_1');
  const good = pool.items.find((row) => row.label === 'cbcn_2');

  assert.equal(good.requests, 1, 'the second account must serve the retried request');
  assert.ok(good.tokensIn > 0);
  assert.equal(limited.requests, 0);
  assert.ok(limited.cooldownUntil > Date.now(), 'the limited account must be parked');
  assert.equal(limited.status, 'cooldown');
  assert.equal(pool.counts.cooldown, 1);
});

await test('account failover tries every account before stopping', async () => {
  for (;;) {
    const page = await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json();
    if (!page.items.length) break;
    for (const row of page.items) await fetch(`${base}/api/providers/codebuddy-cn/accounts/${row.id}`, { method: 'DELETE' });
  }
  for (const token of ['limited-token-1', 'limited-token-2', 'good-token']) {
    const res = await fetch(`${base}/api/providers/codebuddy-cn/accounts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ access_token: token }),
    });
    assert.equal(res.status, 201);
  }
  const chat = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'cbcn/glm-5.3', messages: [{ role: 'user', content: 'failover' }] }),
  });
  const body = await chat.json();
  assert.equal(chat.status, 200, JSON.stringify(body));
  const pool = await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json();
  assert.equal(pool.items.find((row) => row.label === 'cbcn_3').requests, 1);
  assert.equal(pool.items.filter((row) => row.status === 'cooldown').length, 2);
});

await test('image generation resolves, generates, and rejects bad models', async () => {
  for (;;) {
    const page = await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json();
    if (!page.items.length) break;
    for (const row of page.items) await fetch(`${base}/api/providers/codebuddy-cn/accounts/${row.id}`, { method: 'DELETE' });
  }
  await fetch(`${base}/api/providers/codebuddy-cn/accounts`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ access_token: 'good-token' }),
  });

  const missing = await fetch(`${base}/v1/images/generations`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'cbcn/hunyuan-image-alpha' }),
  });
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error.message, /prompt/);

  const unknown = await fetch(`${base}/v1/images/generations`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'cbcn/glm-5.3', prompt: 'a cat' }),
  });
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json()).error.message, /does not generate images/);

  const ok = await fetch(`${base}/v1/images/generations`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'cbcn/hunyuan-image-alpha', prompt: 'a cat', n: 1, size: '1024x1024' }),
  });
  const gen = await ok.json();
  assert.equal(ok.status, 200, JSON.stringify(gen));
  assert.equal(typeof gen.created, 'number');
  assert.equal(gen.data.length, 1);
  assert.equal(gen.data[0].url, 'https://stub.invalid/img.png');

  const catalog = await (await fetch(`${base}/v1/models`)).json();
  assert.ok(catalog.data.some((item) => item.id === 'cbcn/hunyuan-image-alpha' && item.type === 'image'));
});

await test('embeddings validate, normalize, and expose media models', async () => {
  for (;;) {
    const page = await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json();
    if (!page.items.length) break;
    for (const row of page.items) await fetch(`${base}/api/providers/codebuddy-cn/accounts/${row.id}`, { method: 'DELETE' });
  }
  await fetch(`${base}/api/providers/codebuddy-cn/accounts`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ access_token: 'good-token' }),
  });

  const missing = await fetch(`${base}/v1/embeddings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'cbcn/hunyuan-embedding' }),
  });
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error.message, /input/);

  const invalid = await fetch(`${base}/v1/embeddings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'cbcn/hunyuan-embedding', input: [1] }),
  });
  assert.equal(invalid.status, 400);

  const one = await fetch(`${base}/v1/embeddings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'cbcn/hunyuan-embedding', input: 'hello' }),
  });
  const single = await one.json();
  assert.equal(one.status, 200, JSON.stringify(single));
  assert.equal(single.object, 'list');
  assert.equal(single.data[0].object, 'embedding');
  assert.deepEqual(single.data[0].embedding, [5, 0.25]);
  assert.equal(single.data[0].index, 0);

  const many = await fetch(`${base}/v1/embeddings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'cbcn/bge-m3', input: ['a', 'abcd'] }),
  });
  const batch = await many.json();
  assert.equal(many.status, 200, JSON.stringify(batch));
  assert.equal(batch.data.length, 2);
  assert.deepEqual(batch.data.map((item) => item.index), [0, 1]);

  const catalog = await (await fetch(`${base}/v1/models`)).json();
  assert.ok(catalog.data.some((item) => item.id === 'cbcn/hunyuan-embedding' && item.type === 'embedding'));
});

await test('manual account test assigns active, error, cooldown and skipped states', async () => {
  for (;;) {
    const page = await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json();
    if (!page.items.length) break;
    for (const row of page.items) await fetch(`${base}/api/providers/codebuddy-cn/accounts/${row.id}`, { method: 'DELETE' });
  }
  const create = async (label, token) => {
    const res = await fetch(`${base}/api/providers/codebuddy-cn/accounts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label, access_token: token }),
    });
    assert.equal(res.status, 201);
    return (await res.json()).items.find((row) => row.label === label);
  };
  const good = await create('Real test good', 'good-token');
  const bad = await create('Real test bad', 'bad-token');
  const limited = await create('Real test limited', 'limited-token');
  const paused = await create('Real test paused', 'good-token-2');
  const pause = await fetch(`${base}/api/providers/codebuddy-cn/accounts/${paused.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }),
  });
  assert.equal(pause.status, 200);

  const response = await fetch(`${base}/api/providers/codebuddy-cn/accounts/test`, { method: 'POST' });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.attempted, 3);
  assert.equal(body.passed, 1);
  assert.equal(body.failed, 2);
  assert.equal(body.skipped, 1);
  assert.ok(!JSON.stringify(body).includes('good-token'));
  assert.deepEqual(
    body.results.map((item) => [item.account, item.state]),
    [['Real test good', 'active'], ['Real test bad', 'error'], ['Real test limited', 'cooldown'], ['Real test paused', 'disabled']],
  );
  const pool = await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json();
  assert.equal(pool.items.find((row) => row.id === good.id).status, 'active');
  assert.equal(pool.items.find((row) => row.id === bad.id).status, 'error');
  assert.equal(pool.items.find((row) => row.id === limited.id).status, 'cooldown');
});

await test('manual warmup endpoint recovers parked accounts without probing healthy ones', async () => {
  for (;;) {
    const page = await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json();
    if (!page.items.length) break;
    for (const row of page.items) await fetch(`${base}/api/providers/codebuddy-cn/accounts/${row.id}`, { method: 'DELETE' });
  }
  const create = async (label, token) => {
    const res = await fetch(`${base}/api/providers/codebuddy-cn/accounts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label, access_token: token }),
    });
    assert.equal(res.status, 201);
    return (await res.json()).items.find((row) => row.label === label);
  };
  const parked = await create('Manual warmup parked', 'good-token');
  const healthy = await create('Manual warmup healthy', 'high-quota-token');
  markFailure(parked.id, { message: 'temporary error', cooldownMs: 0 });
  const before = quotaCalls.length;
  const response = await fetch(`${base}/api/providers/codebuddy-cn/accounts/warmup`, { method: 'POST' });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.attempted, 1);
  assert.equal(body.recovered, 1);
  assert.equal(quotaCalls.length, before + 1, 'only parked account should be probed');
  assert.equal(quotaCalls.at(-1), 'good-token');
  const pool = await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json();
  assert.equal(pool.items.find((row) => row.id === parked.id).status, 'active');
  assert.equal(pool.items.find((row) => row.id === healthy.id).status, 'active');
  assert.ok(!JSON.stringify(body).includes('good-token'));
});

await test('per-account warmup probes one parked account and skips healthy ones', async () => {
  for (;;) {
    const page = await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json();
    if (!page.items.length) break;
    for (const row of page.items) await fetch(`${base}/api/providers/codebuddy-cn/accounts/${row.id}`, { method: 'DELETE' });
  }
  const create = async (label, token) => {
    const res = await fetch(`${base}/api/providers/codebuddy-cn/accounts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label, access_token: token }),
    });
    assert.equal(res.status, 201);
    return (await res.json()).items.find((row) => row.label === label);
  };
  const parked = await create('Per-account warmup parked', 'good-token');
  const healthy = await create('Per-account warmup healthy', 'high-quota-token');

  const skippedRes = await fetch(`${base}/api/providers/codebuddy-cn/accounts/${healthy.id}/warmup`, { method: 'POST' });
  const skippedBody = await skippedRes.json();
  assert.equal(skippedRes.status, 200, JSON.stringify(skippedBody));
  assert.equal(skippedBody.provider, 'codebuddy-cn');
  assert.equal(skippedBody.skipped, true, 'a healthy account has nothing to warm up');

  markFailure(parked.id, { message: 'temporary error', cooldownMs: 0 });
  const before = quotaCalls.length;
  const response = await fetch(`${base}/api/providers/codebuddy-cn/accounts/${parked.id}/warmup`, { method: 'POST' });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true, 'the parked account must recover');
  assert.equal(quotaCalls.length, before + 1, 'only the parked account is probed');
  assert.equal(quotaCalls.at(-1), 'good-token');
  assert.ok(!JSON.stringify(body).includes('good-token'));

  const pool = await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json();
  assert.equal(pool.items.find((row) => row.id === parked.id).status, 'active');

  for (const account of [parked, healthy]) {
    await fetch(`${base}/api/providers/codebuddy-cn/accounts/${account.id}`, { method: 'DELETE' });
  }
});

await test('account warmup recovers an expired transient cooldown before chat', async () => {
  for (;;) {
    const page = await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json();
    if (!page.items.length) break;
    for (const row of page.items) await fetch(`${base}/api/providers/codebuddy-cn/accounts/${row.id}`, { method: 'DELETE' });
  }
  const created = await fetch(`${base}/api/providers/codebuddy-cn/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Warmup account', access_token: 'good-token' }),
  });
  assert.equal(created.status, 201);
  const account = (await created.json()).items.find((row) => row.label === 'Warmup account');
  assert.ok(account?.id);

  // Simulate a false transient error with an already-expired cooldown.
  markFailure(account.id, { message: 'temporary upstream glitch', cooldownMs: 0 });
  const chat = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'cbcn/glm-5.3', messages: [{ role: 'user', content: 'warmup' }] }),
  });
  const body = await chat.json();
  assert.equal(chat.status, 200, JSON.stringify(body));

  const pool = await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json();
  const recovered = pool.items.find((row) => row.id === account.id);
  assert.equal(recovered.status, 'active');
  assert.equal(recovered.lastError, '');
  assert.equal(recovered.requests, 1);
});

await test('warmup keeps exhausted quota in cooldown', async () => {
  for (;;) {
    const page = await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json();
    if (!page.items.length) break;
    for (const row of page.items) await fetch(`${base}/api/providers/codebuddy-cn/accounts/${row.id}`, { method: 'DELETE' });
  }
  const created = await fetch(`${base}/api/providers/codebuddy-cn/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Warmup exhausted', access_token: 'full-quota-token' }),
  });
  assert.equal(created.status, 201);
  const account = (await created.json()).items.find((row) => row.label === 'Warmup exhausted');
  markFailure(account.id, { message: 'temporary upstream glitch', cooldownMs: 0 });
  const chat = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'cbcn/glm-5.3', messages: [{ role: 'user', content: 'should not chat' }] }),
  });
  assert.equal(chat.status, 429);
  const pool = await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json();
  const parked = pool.items.find((row) => row.id === account.id);
  assert.equal(parked.status, 'cooldown');
  assert.match(parked.lastError, /Quota exhausted/);
  assert.equal(parked.requests, 0);
});

await test('warmup keeps rejected credentials in error', async () => {
  for (;;) {
    const page = await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json();
    if (!page.items.length) break;
    for (const row of page.items) await fetch(`${base}/api/providers/codebuddy-cn/accounts/${row.id}`, { method: 'DELETE' });
  }
  const created = await fetch(`${base}/api/providers/codebuddy-cn/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Warmup rejected', access_token: 'bad-token' }),
  });
  assert.equal(created.status, 201);
  const account = (await created.json()).items.find((row) => row.label === 'Warmup rejected');
  markFailure(account.id, { message: 'temporary upstream glitch', cooldownMs: 0 });
  const chat = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'cbcn/glm-5.3', messages: [{ role: 'user', content: 'should not chat' }] }),
  });
  assert.equal(chat.status, 429);
  const pool = await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json();
  const rejected = pool.items.find((row) => row.id === account.id);
  assert.equal(rejected.status, 'error');
  assert.match(rejected.lastError, /Credential rejected by CodeBuddy/);
  assert.equal(rejected.cooldownUntil, 0);
  assert.equal(rejected.requests, 0);
});

await test('usage history persists requests through the chat route', async () => {
  for (;;) {
    const page = await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json();
    if (!page.items.length) break;
    for (const row of page.items) {
      await fetch(`${base}/api/providers/codebuddy-cn/accounts/${row.id}`, { method: 'DELETE' });
    }
  }
  const account = await fetch(`${base}/api/providers/codebuddy-cn/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Usage account', access_token: 'usage-token' }),
  });
  assert.equal(account.status, 201);

  const before = await (await fetch(`${base}/api/usage?range=day`)).json();
  const chat = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'cbcn/glm-5.3',
      stream: true,
      messages: [{ role: 'user', content: 'usage smoke' }],
    }),
  });
  assert.equal(chat.status, 200);
  // Drain the stream so the relay finishes recording.
  for await (const event of readSSEEvents(chat.body)) void event;

  const after = await (await fetch(`${base}/api/usage?range=day`)).json();
  assert.equal(after.totals.requests, before.totals.requests + 1, 'one request must land in history');
  assert.equal(after.totals.errors, before.totals.errors, 'a successful stream must not count as an error');
  assert.ok(after.totals.tokensIn > before.totals.tokensIn, 'stub usage must be recorded');
  assert.ok(after.totals.tokensOut > before.totals.tokensOut);

  // Usage is cumulative for the day, so compare the delta rather than assuming
  // this is the first request against the model.
  const beforeRow = before.models.find((item) => item.provider === 'codebuddy-cn' && item.model === 'glm-5.3');
  const row = after.models.find((item) => item.provider === 'codebuddy-cn' && item.model === 'glm-5.3');
  assert.ok(row, 'the model breakdown must include the called model');
  assert.equal(row.requests, (beforeRow?.requests || 0) + 1);
  assert.ok(row.avgMs != null, 'average latency is reported');
  assert.ok(after.series.some((item) => item.requests > 0), 'the current hour bucket must carry the request');
  assert.ok(after.activity.some((item) => item.model === 'glm-5.3'), 'activity must include the called model');
  const activity = after.activity.find((item) => item.model === 'glm-5.3');
  assert.equal(activity.provider, 'codebuddy-cn');
  assert.equal(activity.account, 'Usage account');
  assert.ok(activity.tokensIn > 0 && activity.tokensOut > 0);
  assert.equal(activity.status, 200);
  assert.equal(activity.ok, true);
  assert.doesNotMatch(JSON.stringify(activity), /usage-token/);
  assert.ok(Array.isArray(after.active), 'usage report must expose the in-flight request list');
  const status = await (await fetch(`${base}/api/status`)).json();
  assert.ok(Array.isArray(status.active), 'status snapshot must expose the in-flight request list');

  // The history is in SQLite, not only in the in-memory snapshot.
  const disk = new DatabaseSync(DB_FILE, { readOnly: true });
  try {
    const saved = disk.prepare(
      'SELECT SUM(requests) AS requests FROM usage_hourly WHERE provider = ? AND model = ?',
    ).get('codebuddy-cn', 'glm-5.3');
    assert.ok(Number(saved.requests) >= 1, 'usage_hourly must hold the row');
  } finally {
    disk.close();
  }

  const accountRow = (await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json()).items
    .find((item) => item.label === 'Usage account');
  if (accountRow) await fetch(`${base}/api/providers/codebuddy-cn/accounts/${accountRow.id}`, { method: 'DELETE' });
});

await test('in-flight requests are tracked and cleared in the status snapshot', async () => {
  const { beginActiveRequest, endActiveRequest, activeRequestSnapshot, statusSnapshot } = await import('../noroute_src/lib/stats.js');
  const id = beginActiveRequest({ provider: 'codebuddy-cn', model: 'glm-5.3', account: 'live' });
  const during = activeRequestSnapshot();
  assert.ok(during.some((item) => item.model === 'glm-5.3'), 'active request must appear mid-flight');
  assert.ok(during.find((item) => item.model === 'glm-5.3').provider === 'codebuddy-cn');
  assert.ok(Array.isArray(statusSnapshot().active), 'status snapshot must carry active requests');
  endActiveRequest(id);
  assert.ok(!activeRequestSnapshot().some((item) => item.model === 'glm-5.3'), 'active request must clear after completion');
});

await test('quota payload is split into refill and bonus packages', () => {
  const parsed = parseCodebuddyQuota({
    code: 0,
    data: {
      Response: {
        Data: {
          Accounts: [
            {
              PackageName: 'Pro',
              CycleStartTime: '2026-10-01T00:00:00+08:00',
              CycleEndTime: '2026-11-01T00:00:00+08:00',
              DeductionEndTime: '2027-11-01T00:00:00+08:00',
              CycleCapacityUsed: 10,
              CycleCapacitySize: 100,
            },
            {
              PackageName: 'Bonus',
              CycleStartTime: '2026-10-20T00:00:00+08:00',
              CycleEndTime: '2026-11-01T00:00:00+08:00',
              DeductionEndTime: '2026-11-01T00:00:00+08:00',
              CapacityUsed: 5,
              CapacitySize: 20,
            },
          ],
        },
      },
    },
  });

  assert.equal(parsed.used, 15);
  assert.equal(parsed.total, 120);
  assert.equal(parsed.packages.length, 2);
  assert.equal(parsed.packages[0].recurring, true);
  assert.equal(parsed.packages[1].recurring, false);
  assert.equal(parsed.packages[1].name, 'Bonus pack 1');
});

await test('missing provider for account routes returns 404', async () => {
  const res = await fetch(`${base}/api/providers/nope/accounts`);
  assert.equal(res.status, 404);
});

await test('combo CRUD validates names and models', async () => {
  // The stub-only failure models must exist in the catalog before a combo may
  // reference them, exactly like a real model id.
  for (const model of ['combo-always-429', 'combo-always-400']) {
    await fetch(`${base}/api/providers/codebuddy-cn/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
    });
  }
  const create = await fetch(`${base}/api/combos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'premium-coding', models: ['cbcn/combo-always-429', 'cbcn/combo-always-400'] }),
  });
  const created = await create.json();
  assert.equal(create.status, 201, JSON.stringify(created));
  assert.equal(created.combo.name, 'premium-coding');
  assert.deepEqual(created.combo.models, ['cbcn/combo-always-429', 'cbcn/combo-always-400']);

  const duplicate = await fetch(`${base}/api/combos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'premium-coding', models: ['cbcn/glm-5.3'] }),
  });
  assert.equal(duplicate.status, 409);

  const slashed = await fetch(`${base}/api/combos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'combo/x', models: ['cbcn/glm-5.3'] }),
  });
  assert.equal(slashed.status, 400);
  assert.match((await slashed.json()).error.message, /cannot contain/);

  const unknown = await fetch(`${base}/api/combos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'bad-model-combo', models: ['cbcn/not-a-model'] }),
  });
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json()).error.message, /Unknown model/);

  const empty = await fetch(`${base}/api/combos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'empty-combo', models: [] }),
  });
  assert.equal(empty.status, 400);

  const patch = await fetch(`${base}/api/combos/${encodeURIComponent(created.combo.id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ models: ['cbcn/glm-5.3'] }),
  });
  const patched = await patch.json();
  assert.equal(patch.status, 200, JSON.stringify(patched));
  assert.deepEqual(patched.combo.models, ['cbcn/glm-5.3']);

  const listed = await (await fetch(`${base}/api/combos`)).json();
  assert.ok(listed.combos.some((combo) => combo.name === 'premium-coding'));

  const missing = await fetch(`${base}/api/combos/does-not-exist`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'x' }),
  });
  assert.equal(missing.status, 404);

  const removed = await fetch(`${base}/api/combos/${encodeURIComponent(created.combo.id)}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  const gone = await fetch(`${base}/api/combos/${encodeURIComponent(created.combo.id)}`, { method: 'DELETE' });
  assert.equal(gone.status, 404);
});

await test('combo model picker lists only enabled models', async () => {
  const before = await (await fetch(`${base}/api/combos`)).json();
  assert.ok(Array.isArray(before.catalog), 'catalog must be returned');
  assert.ok(before.catalog.length > 0);
  assert.ok(before.catalog.every((entry) => entry.id && entry.model && entry.provider));
  // Combos themselves are not pickable, so the catalog holds provider models only.
  assert.ok(!before.catalog.some((entry) => entry.provider === 'norouter'));

  const target = before.catalog.find((entry) => entry.provider === 'codebuddy-cn');
  assert.ok(target, 'expected at least one CodeBuddy model');

  const disable = await fetch(`${base}/api/providers/codebuddy-cn/models/${encodeURIComponent(target.model)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(disable.status, 200);
  try {
    const after = await (await fetch(`${base}/api/combos`)).json();
    assert.equal(after.catalog.length, before.catalog.length - 1, 'disabled model must leave the picker');
    assert.ok(!after.catalog.some((entry) => entry.model === target.model && entry.provider === 'codebuddy-cn'));
  } finally {
    await fetch(`${base}/api/providers/codebuddy-cn/models/${encodeURIComponent(target.model)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    const restored = await (await fetch(`${base}/api/combos`)).json();
    assert.equal(restored.catalog.length, before.catalog.length, 're-enabled model must return');
  }
});

await test('combo name appears in the model catalog next to provider models', async () => {
  const create = await fetch(`${base}/api/combos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'catalog-combo', models: ['cbcn/glm-5.3'] }),
  });
  assert.equal(create.status, 201);
  try {
    const catalog = await (await fetch(`${base}/v1/models`)).json();
    const combo = catalog.data.find((m) => m.id === 'catalog-combo');
    assert.ok(combo, 'combo must be listed');
    assert.equal(combo.object, 'model');
    assert.equal(combo.owned_by, 'norouter');
    assert.ok(catalog.data.some((m) => m.id === 'cbcn/glm-5.3'), 'provider models must remain');
  } finally {
    const listed = await (await fetch(`${base}/api/combos`)).json();
    const row = listed.combos.find((c) => c.name === 'catalog-combo');
    if (row) await fetch(`${base}/api/combos/${encodeURIComponent(row.id)}`, { method: 'DELETE' });
  }
});

await test('combo falls back to the next model and records the serving model', async () => {
  // Two accounts: the first model's 429 parks one account, and the fallback
  // model still needs a healthy credential to prove the request actually moved.
  for (;;) {
    const page = await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json();
    if (!page.items.length) break;
    for (const row of page.items) {
      await fetch(`${base}/api/providers/codebuddy-cn/accounts/${row.id}`, { method: 'DELETE' });
    }
  }
  for (const token of ['combo-token-a', 'combo-token-b']) {
    await fetch(`${base}/api/providers/codebuddy-cn/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: `Combo ${token}`, access_token: token }),
    });
  }

  const create = await fetch(`${base}/api/combos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'fallback-combo', models: ['cbcn/combo-always-429', 'cbcn/glm-5.3'] }),
  });
  const created = await create.json();
  assert.equal(create.status, 201, JSON.stringify(created));
  const before = await (await fetch(`${base}/api/usage?range=day`)).json();
  try {
    stubCalls.length = 0;
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fallback-combo', messages: [{ role: 'user', content: 'halo' }] }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.match(body.choices[0].message.content, /stub reply for glm-5\.3/);
    assert.deepEqual(stubCalls, ['combo-always-429', 'glm-5.3'], 'first model must be tried then skipped');

    const comboLog = (await (await fetch(`${base}/api/request-log`)).json()).requests.at(-1);
    assert.equal(comboLog.requested, 'fallback-combo');
    assert.equal(comboLog.route, 'combo');
    assert.equal(comboLog.via, 'fallback-combo');
    assert.equal(comboLog.model, 'glm-5.3');
    assert.deepEqual(comboLog.attempted, ['cbcn/combo-always-429', 'cbcn/glm-5.3'], 'trace must name the walked chain');

    const after = await (await fetch(`${base}/api/usage?range=day`)).json();
    const delta = after.totals.requests - before.totals.requests;
    assert.equal(delta, 1, 'one combo request counts once');
    const served = after.models.find((m) => m.model === 'glm-5.3' && m.provider === 'codebuddy-cn');
    assert.ok(served, 'usage must attribute the request to the serving model');
    assert.ok(!after.models.some((m) => m.model === 'fallback-combo'), 'usage must not record the combo name');
  } finally {
    await fetch(`${base}/api/combos/${encodeURIComponent(created.combo.id)}`, { method: 'DELETE' });
  }
});

await test('a request-shaped 400 does not trigger combo fallback', async () => {
  const create = await fetch(`${base}/api/combos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'client-bug-combo', models: ['cbcn/combo-always-400', 'cbcn/glm-5.3'] }),
  });
  const created = await create.json();
  assert.equal(create.status, 201, JSON.stringify(created));
  try {
    stubCalls.length = 0;
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'client-bug-combo', messages: [{ role: 'user', content: 'halo' }] }),
    });
    assert.equal(res.status, 400, 'the client error must be relayed as-is');
    const body = await res.json();
    assert.match(body.error.message, /context overflow/);
    assert.deepEqual(stubCalls, ['combo-always-400'], 'the second model must never be called');
  } finally {
    await fetch(`${base}/api/combos/${encodeURIComponent(created.combo.id)}`, { method: 'DELETE' });
  }
});

await test('when every combo model fails the first fallback status is returned', async () => {
  const create = await fetch(`${base}/api/combos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'all-fail-combo', models: ['cbcn/combo-always-429', 'cbcn/combo-always-429'] }),
  });
  const created = await create.json();
  assert.equal(create.status, 201, JSON.stringify(created));
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'all-fail-combo', messages: [{ role: 'user', content: 'halo' }] }),
    });
    const body = await res.json();
    assert.equal(res.status, 429, 'status must come from the first fallback failure');
    assert.match(body.error.message, /all-fail-combo/);
    assert.match(body.error.message, /Tried:/);
    assert.ok(!JSON.stringify(body).includes('combo-token'), 'credentials must not leak');
  } finally {
    await fetch(`${base}/api/combos/${encodeURIComponent(created.combo.id)}`, { method: 'DELETE' });
  }
});

await test('a combo whose models all vanished resolves to a clear 400, not 500', async () => {
  // Build a combo around a custom model, then remove that model. The stored
  // combo now points at nothing, which is the "all entries invalid" case.
  const model = `combo-vanish-${Date.now()}`;
  await fetch(`${base}/api/providers/codebuddy-cn/models`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  const created = await fetch(`${base}/api/combos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'vanishing-combo', models: [`cbcn/${model}`] }),
  });
  const body = await created.json();
  assert.equal(created.status, 201, JSON.stringify(body));

  await fetch(`${base}/api/providers/codebuddy-cn/models/${encodeURIComponent(model)}`, { method: 'DELETE' });

  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'vanishing-combo', messages: [{ role: 'user', content: 'x' }] }),
  });
  const failed = await res.json();
  assert.equal(res.status, 400, JSON.stringify(failed));
  assert.match(failed.error.message, /combo|Unknown model/i);

  await fetch(`${base}/api/combos/${encodeURIComponent(body.combo.id)}`, { method: 'DELETE' });
});

await test('vision routing validates, stores canonical targets and persists', async () => {
  const initial = await (await fetch(`${base}/api/vision-routing`)).json();
  assert.equal(initial.vision.enabled, false);
  assert.equal(initial.vision.strategy, 'order');
  assert.deepEqual(initial.vision.models, []);
  assert.ok(Array.isArray(initial.catalog) && initial.catalog.length > 0);

  const patch = (payload) => fetch(`${base}/api/vision-routing`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const unknown = await patch({ audio: true });
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json()).error.message, /Unknown/);

  const badStrategy = await patch({ strategy: 'random' });
  assert.equal(badStrategy.status, 400);
  assert.match((await badStrategy.json()).error.message, /strategy/);

  const unknownModel = await patch({ models: ['cbcn/not-a-model'] });
  assert.equal(unknownModel.status, 400);
  assert.match((await unknownModel.json()).error.message, /Invalid vision model/);

  const empty = await patch({ enabled: true, models: [] });
  assert.equal(empty.status, 400);
  assert.match((await empty.json()).error.message, /at least one/);

  const duplicate = await patch({ models: ['cbcn/glm-5.3', 'cbcn/glm-5.3'] });
  assert.equal(duplicate.status, 400);
  assert.match((await duplicate.json()).error.message, /twice/);

  try {
    const saved = await patch({
      enabled: true,
      strategy: 'round-robin',
      models: ['deepseek-v4.1-flash', 'cbcn/glm-5.3'],
    });
    const body = await saved.json();
    assert.equal(saved.status, 200, JSON.stringify(body));
    assert.equal(body.vision.enabled, true);
    assert.equal(body.vision.strategy, 'round-robin');
    assert.deepEqual(body.vision.models, ['cbcn/deepseek-v4.1-flash', 'cbcn/glm-5.3'], 'bare names must be stored prefixed');

    const reread = await (await fetch(`${base}/api/vision-routing`)).json();
    assert.equal(reread.vision.enabled, true);
    assert.deepEqual(reread.vision.models, ['cbcn/deepseek-v4.1-flash', 'cbcn/glm-5.3']);
  } finally {
    await patch({ enabled: false, strategy: 'order', models: [] });
  }
});

await test('enabled vision routing forces image requests onto its chain', async () => {
  // The combo tests above park the whole pool on purpose to prove fallback, so a
  // stale cooldown would hide the routing. Replace the pool with one fresh account.
  for (;;) {
    const page = await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json();
    if (!page.items.length) break;
    for (const row of page.items) {
      await fetch(`${base}/api/providers/codebuddy-cn/accounts/${row.id}`, { method: 'DELETE' });
    }
  }
  const seeded = await fetch(`${base}/api/providers/codebuddy-cn/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Vision', access_token: 'vision-token' }),
  });
  assert.equal(seeded.status, 201);

  const patch = (payload) => fetch(`${base}/api/vision-routing`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const post = (model, content) => fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }] }),
  });
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };

  const combo = await fetch(`${base}/api/combos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'vision-bypass', models: ['cbcn/glm-5.3'] }),
  });
  const comboBody = await combo.json();
  assert.equal(combo.status, 201, JSON.stringify(comboBody));

  try {
    const saved = await patch({ enabled: true, strategy: 'order', models: ['cbcn/deepseek-v4.1-flash'] });
    assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));

    stubCalls.length = 0;
    const forced = await post('cbcn/glm-5.3', [{ type: 'text', text: 'what is this?' }, image]);
    const forcedBody = await forced.json();
    assert.equal(forced.status, 200, JSON.stringify(forcedBody));
    assert.match(forcedBody.choices[0].message.content, /deepseek-v4\.1-flash/);
    assert.deepEqual(stubCalls, ['deepseek-v4.1-flash'], 'image request must ignore the requested model');

    const forcedLog = (await (await fetch(`${base}/api/request-log`)).json()).requests.at(-1);
    assert.equal(forcedLog.requested, 'cbcn/glm-5.3', 'trace must keep the model the client asked for');
    assert.equal(forcedLog.route, 'vision');
    assert.equal(forcedLog.model, 'deepseek-v4.1-flash');
    assert.equal(forcedLog.image, true);
    assert.deepEqual(forcedLog.attempted, ['cbcn/deepseek-v4.1-flash']);

    // A combo name is bypassed exactly like a plain provider model.
    stubCalls.length = 0;
    const viaCombo = await post('vision-bypass', [{ type: 'input_image', image_url: 'https://example.invalid/pic.png' }, { type: 'input_text', text: 'describe' }]);
    const viaComboBody = await viaCombo.json();
    assert.equal(viaCombo.status, 200, JSON.stringify(viaComboBody));
    assert.deepEqual(stubCalls, ['deepseek-v4.1-flash'], 'combo request with an image must follow vision routing');

    // Text-only requests are untouched while the rule is on.
    stubCalls.length = 0;
    const plain = await post('cbcn/glm-5.3', 'halo');
    const plainBody = await plain.json();
    assert.equal(plain.status, 200, JSON.stringify(plainBody));
    assert.deepEqual(stubCalls, ['glm-5.3'], 'text-only request must keep its model');

    const plainLog = (await (await fetch(`${base}/api/request-log`)).json()).requests.at(-1);
    assert.equal(plainLog.route, 'direct');
    assert.equal(plainLog.image, false);
    assert.equal(plainLog.requested, 'cbcn/glm-5.3');
  } finally {
    await patch({ enabled: false, strategy: 'order', models: [] });
    await fetch(`${base}/api/combos/${encodeURIComponent(comboBody.combo.id)}`, { method: 'DELETE' });
  }
});

await test('vision routing only follows images in the current turn', async () => {
  const patch = (payload) => fetch(`${base}/api/vision-routing`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };
  const post = (messages) => fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'cbcn/glm-5.3', messages }),
  });
  try {
    const saved = await patch({ enabled: true, strategy: 'order', models: ['cbcn/deepseek-v4.1-flash'] });
    assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));

    // Every turn resends the conversation. An image that was already read in an
    // earlier turn must not keep pulling later text-only turns onto the chain.
    stubCalls.length = 0;
    const later = await post([
      { role: 'user', content: [{ type: 'text', text: 'what is this?' }, image] },
      { role: 'assistant', content: 'A red square.' },
      { role: 'user', content: 'now audit the code' },
    ]);
    const laterBody = await later.json();
    assert.equal(later.status, 200, JSON.stringify(laterBody));
    assert.deepEqual(stubCalls, ['glm-5.3'], 'an earlier image must not reroute a later text-only turn');

    // The requested model gets a payload it can accept: the historical image is
    // replaced with text, while the latest user message is untouched.
    const forwarded = chatBodies.at(-1);
    const replayed = forwarded.messages.find((message) => message.role === 'user');
    assert.equal(replayed.content[1].type, 'text');
    assert.match(replayed.content[1].text, /image omitted/);
    assert.equal(forwarded.messages.at(-1).content, 'now audit the code');

    // A screenshot returned by a tool during the current turn is still current
    // input, so it keeps the vision chain.
    stubCalls.length = 0;
    const tool = await post([
      { role: 'user', content: 'take a screenshot' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'screenshot', arguments: '{}' } }],
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
      },
    ]);
    const toolBody = await tool.json();
    assert.equal(tool.status, 200, JSON.stringify(toolBody));
    assert.deepEqual(stubCalls, ['deepseek-v4.1-flash'], 'an image in the current turn must use the vision chain');

    // A tool-loop continuation replays the image it was given but adds no new
    // one. The vision chain already read it, so the requested model continues
    // the turn and receives the same placeholder a later text-only turn gets.
    stubCalls.length = 0;
    const continuation = await post([
      { role: 'user', content: [{ type: 'text', text: 'read this screenshot' }, image] },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'screenshot', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_2', content: 'captured' },
    ]);
    const continuationBody = await continuation.json();
    assert.equal(continuation.status, 200, JSON.stringify(continuationBody));
    assert.deepEqual(stubCalls, ['glm-5.3'], 'a tool-loop continuation must keep the requested model');
    const continued = chatBodies.at(-1);
    const continuedUser = continued.messages.find((message) => message.role === 'user');
    assert.equal(continuedUser.content[1].type, 'text');
    assert.match(continuedUser.content[1].text, /image omitted/);
    assert.equal(continued.messages.at(-1).content, 'captured');
  } finally {
    await patch({ enabled: false, strategy: 'order', models: [] });
  }
});

await test('disabled vision routing leaves image requests on their model', async () => {
  stubCalls.length = 0;
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'cbcn/glm-5.3',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }],
    }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.deepEqual(stubCalls, ['glm-5.3'], 'disabled rule must not reroute image requests');
});

await test('vision round robin starts at the next target per image request', async () => {
  const patch = (payload) => fetch(`${base}/api/vision-routing`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };
  try {
    const saved = await patch({ enabled: true, strategy: 'round-robin', models: ['cbcn/glm-5.3', 'cbcn/deepseek-v4.1-flash'] });
    assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));

    stubCalls.length = 0;
    for (let i = 0; i < 3; i += 1) {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'cbcn/glm-5.3', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }, image] }] }),
      });
      assert.equal(res.status, 200, `request ${i + 1} failed`);
    }
    assert.deepEqual(stubCalls, ['glm-5.3', 'deepseek-v4.1-flash', 'glm-5.3'], 'round robin must rotate the first target');
  } finally {
    await patch({ enabled: false, strategy: 'order', models: [] });
  }
});

await test('vision routing skips saved targets that no longer resolve', async () => {
  const model = `vision-vanish-${Date.now()}`;
  await fetch(`${base}/api/providers/codebuddy-cn/models`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  const patch = (payload) => fetch(`${base}/api/vision-routing`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  try {
    const saved = await patch({ enabled: true, strategy: 'order', models: [`cbcn/${model}`] });
    assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));
    await fetch(`${base}/api/providers/codebuddy-cn/models/${encodeURIComponent(model)}`, { method: 'DELETE' });

    stubCalls.length = 0;
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'cbcn/glm-5.3',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }],
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.deepEqual(stubCalls, ['glm-5.3'], 'a stale vision config must not break the request');
  } finally {
    await patch({ enabled: false, strategy: 'order', models: [] });
  }
});

await test('account backup exports raw tokens and restores by merge', async () => {
  for (;;) {
    const page = await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json();
    if (!page.items.length) break;
    for (const row of page.items) await fetch(`${base}/api/providers/codebuddy-cn/accounts/${row.id}`, { method: 'DELETE' });
  }
  const created = await fetch(`${base}/api/providers/codebuddy-cn/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Backup source', access_token: 'backup-token' }),
  });
  assert.equal(created.status, 201);

  const exportRes = await fetch(`${base}/api/settings/accounts/export`);
  assert.equal(exportRes.status, 200);
  assert.match(exportRes.headers.get('content-disposition') || '', /attachment/);
  const backup = await exportRes.json();
  assert.equal(backup.version, 1);
  assert.ok(Array.isArray(backup.accounts));
  assert.ok(backup.accounts.some((a) => a.access_token === 'backup-token'), 'export must contain the raw token');

  // Restoring the same file adds nothing: every row is a fingerprint duplicate.
  const restore1 = await fetch(`${base}/api/settings/accounts/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(backup),
  });
  const r1 = await restore1.json();
  assert.equal(restore1.status, 200, JSON.stringify(r1));
  assert.equal(r1.added, 0);
  assert.ok(r1.duplicates >= 1, 're-importing the same file must report duplicates');

  // A fresh account is merged in; existing rows are never deleted.
  const mixed = {
    version: 1,
    accounts: [...backup.accounts, { provider: 'codebuddy-cn', label: 'Restored extra', access_token: 'restored-token' }],
  };
  const restore2 = await fetch(`${base}/api/settings/accounts/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(mixed),
  });
  const r2 = await restore2.json();
  assert.equal(restore2.status, 200, JSON.stringify(r2));
  assert.equal(r2.added, 1);
  assert.ok(r2.duplicates >= 1);

  const pool = await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json();
  assert.ok(pool.items.some((row) => row.label === 'Backup source'), 'existing account must survive restore');

  const bad = await fetch(`${base}/api/settings/accounts/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nope: true }),
  });
  assert.equal(bad.status, 400);
});

await test('Antigravity registers its model catalog and tier map', () => {
  const resolved = resolveModel('ag/gemini-3.8-flash');
  assert.equal(resolved.error, undefined, resolved.error);
  assert.equal(resolved.provider.id, 'antigravity');
  assert.equal(resolved.provider.format, 'antigravity');
  assert.equal(resolved.provider.chatPath, '/v1internal:generateContent');
  assert.match(resolved.provider.streamPath, /v1internal:streamGenerateContent/);
  assert.equal(resolved.provider.requiresAccount, true);
  // The bare id is an alias; the gateway expects the tier id itself.
  assert.equal(resolved.provider.upstreamModels['gemini-3.8-flash'], 'gemini-3.8-flash-medium');
  assert.ok(resolved.provider.models.includes('gemini-3.8-flash-high'), 'the explicit tier ids stay public');
  assert.ok(resolved.provider.models.includes('gemini-3.1-flash-lite'), 'the catalog mirrors the gateway list');
  assert.ok(resolveModel('ag/not-a-model').error, 'unknown Antigravity models must not resolve');
});

// Every test below shares one Antigravity pool; clearing it up front keeps a
// failed assertion from leaking a credential into the next test.
async function clearAntigravityAccounts() {
  const pool = await (await fetch(`${base}/api/providers/antigravity/accounts?pageSize=200`)).json();
  for (const account of pool.items) {
    await fetch(`${base}/api/providers/antigravity/accounts/${account.id}`, { method: 'DELETE' });
  }
}

await test('Antigravity wraps chat in the Cloud Code envelope', async () => {
  antigravityBodies.length = 0;
  try {
    const created = await fetch(`${base}/api/providers/antigravity/accounts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Antigravity wire', access_token: 'ag-access-token', projectId: 'stub-project' }),
    });
    const account = await created.json();
    assert.equal(created.status, 201, JSON.stringify(account));
    const row = account.items.find((item) => item.label === 'Antigravity wire');
    const stored = getDb().prepare('SELECT project_id FROM accounts WHERE id = ?').get(row.id);
    assert.equal(stored.project_id, 'stub-project', 'the account must persist its project id');

    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'ag/gemini-3.8-flash',
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'Hello envelope' },
        ],
        temperature: 0.2,
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.choices[0].message.content, 'I am the gemini-3.8-flash-medium Antigravity model.');

    const envelope = antigravityBodies.at(-1);
    assert.equal(envelope.project, 'stub-project');
    assert.equal(envelope.model, 'gemini-3.8-flash-medium');
    assert.equal(envelope.userAgent, 'antigravity');
    assert.match(envelope.requestId, /^agent\/[0-9a-f-]{36}\/\d+\/[0-9a-f-]{36}\/\d+$/);
    // The gateway types request.session_id as TYPE_STRING; a JSON number is rejected.
    assert.equal(typeof envelope.request.sessionId, 'string');
    assert.match(envelope.request.sessionId, /^\d+$/);
    assert.match(envelope.request.systemInstruction.parts[0].text, /^Be brief\./);
    assert.equal(envelope.request.contents[0].role, 'user');
    assert.equal(envelope.request.contents[0].parts[0].text, 'Hello envelope');
    assert.equal(envelope.request.generationConfig.temperature, 0.2);
    // The agent path must stay free of these three; the stub rejects them.
    assert.equal('requestType' in envelope.request, false);
    assert.equal('safetySettings' in envelope.request, false);
    assert.equal('stream_options' in envelope.request, false);
  } finally {
    await clearAntigravityAccounts();
  }
});

await test('Antigravity streams translated chat chunks', async () => {
  antigravityBodies.length = 0;
  try {
    const created = await fetch(`${base}/api/providers/antigravity/accounts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Antigravity stream', access_token: 'ag-stream-token' }),
    });
    assert.equal(created.status, 201);

    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'ag/gemini-3.8-flash-high',
        messages: [{ role: 'user', content: 'Hello stream' }],
        stream: true,
      }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /"object":"chat\.completion\.chunk"/);
    assert.match(text, /"role":"assistant"/);
    assert.match(text, /"content":"I am the "/);
    assert.match(text, /"content":"gemini-3\.8-flash-high Antigravity model\."/);
    assert.match(text, /"finish_reason":"stop"/);
    assert.match(text, /"prompt_tokens":11/);
    assert.match(text, /"completion_tokens":7/);
    assert.match(text, /"total_tokens":18/);
    assert.match(text, /data: \[DONE\]/);

    const envelope = antigravityBodies.at(-1);
    assert.equal(envelope.model, 'gemini-3.8-flash-high');
    assert.ok(envelope.project, 'a missing project id must be generated, not sent empty');
    assert.equal(envelope.request.contents[0].parts[0].text, 'Hello stream');
  } finally {
    await clearAntigravityAccounts();
  }
});

await test('Antigravity model test probes through the same envelope', async () => {
  antigravityBodies.length = 0;
  try {
    const created = await fetch(`${base}/api/providers/antigravity/accounts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Antigravity probe', access_token: 'ag-probe-token', projectId: 'probe-project' }),
    });
    assert.equal(created.status, 201);

    const res = await fetch(`${base}/api/providers/antigravity/models/test`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-3.8-flash-low' }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.results[0].ok, true, JSON.stringify(body.results[0]));
    assert.match(body.results[0].answer, /gemini-3\.8-flash-low Antigravity model/);

    const envelope = antigravityBodies.at(-1);
    assert.equal(envelope.project, 'probe-project');
    assert.equal(envelope.model, 'gemini-3.8-flash-low');
    // The probe must not invent sampling params the caller did not send.
    assert.equal(envelope.request.generationConfig.temperature, undefined);
  } finally {
    await clearAntigravityAccounts();
  }
});

await test('Antigravity quota reads the shared Cloud Code pools', async () => {
  antigravityQuotaCalls.length = 0;
  try {
    const detail = await (await fetch(`${base}/api/providers/antigravity`)).json();
    assert.equal(detail.provider.quotaSupported, true, 'the Quota tab must be enabled');
    assert.match(detail.quota.note, /Cloud Code quota summary/);

    const created = await fetch(`${base}/api/providers/antigravity/accounts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Antigravity quota', access_token: 'ag-quota-token', projectId: 'stub-project' }),
    });
    assert.equal(created.status, 201);
    const row = (await created.json()).items.find((item) => item.label === 'Antigravity quota');

    const res = await fetch(`${base}/api/providers/antigravity/accounts/${row.id}/quota`, { method: 'POST' });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.quota.plan, 'Free tier');
    assert.equal(body.quota.planKey, 'free');

    const windows = body.quota.quotas;
    assert.equal(windows.gemini_weekly.displayName, 'Gemini (Weekly)');
    assert.equal(windows.gemini_weekly.used, 60);
    assert.equal(windows.gemini_weekly.total, 100);
    assert.equal(windows.gemini_weekly.resetAt, Date.parse('2026-11-15T16:06:23Z'));
    assert.equal(windows.claude_gpt_weekly.displayName, 'Claude & GPT (Weekly)');
    assert.equal(windows.claude_gpt_weekly.used, 100);
    // A session pool disabled by upstream is still listed, as fully used.
    assert.equal(windows.claude_gpt_session.used, 100);
    assert.equal(JSON.stringify(body).includes('ag-quota-token'), false, 'the token must never be echoed');

    const paths = antigravityQuotaCalls.map((call) => call.path);
    assert.ok(paths.includes('loadCodeAssist'), 'the tier lookup must run');
    assert.ok(paths.includes('quotaSummary'), 'the summary is the primary source');
    assert.equal(paths.includes('availableModels'), false, 'free tier must not read per-model quota');
    const summary = antigravityQuotaCalls.find((call) => call.path === 'quotaSummary');
    assert.equal(summary.body.project, 'stub-project');
    assert.equal(summary.body.metadata, undefined, 'the summary takes a project, not client metadata');

    // A truly free account reports its starter tier in both fields, so the
    // stored plan must stay free.
    const pool = await (await fetch(`${base}/api/providers/antigravity/accounts?pageSize=200`)).json();
    assert.equal(pool.items.find((item) => item.id === row.id).plan, 'free');
  } finally {
    await clearAntigravityAccounts();
  }
});

await test('Antigravity quota falls back to per-model rows on paid tiers', async () => {
  antigravityQuotaCalls.length = 0;
  try {
    const created = await fetch(`${base}/api/providers/antigravity/accounts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Antigravity paid quota', access_token: 'ag-paid-quota-token' }),
    });
    assert.equal(created.status, 201);
    const row = (await created.json()).items.find((item) => item.label === 'Antigravity paid quota');

    const res = await fetch(`${base}/api/providers/antigravity/accounts/${row.id}/quota`, { method: 'POST' });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    // Antigravity keeps `currentTier` at free-tier even on a paid login, so the
    // Google One plan in `paidTier` is what the badge must show.
    assert.equal(body.quota.plan, 'Pro tier');
    assert.equal(body.quota.planKey, 'pro');
    const windows = body.quota.quotas;
    assert.equal(windows['model_gemini-3.8-flash-high'].used, 80);
    assert.equal(windows['model_claude-sonnet-4-6'].used, 25);
    assert.equal(Object.keys(windows).some((key) => key.includes('internal')), false, 'internal models are not a quota window');
    assert.ok(antigravityQuotaCalls.some((call) => call.path === 'availableModels'));

    // Reading quota is also what teaches the pool the account's tier.
    const pool = await (await fetch(`${base}/api/providers/antigravity/accounts?pageSize=200`)).json();
    assert.equal(pool.items.find((item) => item.id === row.id).plan, 'pro');
  } finally {
    await clearAntigravityAccounts();
  }
});

await test('Antigravity labels Google AI Plus and Ultra accounts from paidTier', async () => {
  antigravityQuotaCalls.length = 0;
  try {
    const cases = [
      { label: 'Antigravity plus quota', token: 'ag-plus-quota-token', plan: 'Plus tier', key: 'plus' },
      { label: 'Antigravity ultra quota', token: 'ag-ultra-quota-token', plan: 'Ultra tier', key: 'ultra' },
    ];
    for (const expected of cases) {
      const created = await fetch(`${base}/api/providers/antigravity/accounts`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: expected.label, access_token: expected.token }),
      });
      assert.equal(created.status, 201);
      const row = (await created.json()).items.find((item) => item.label === expected.label);

      const res = await fetch(`${base}/api/providers/antigravity/accounts/${row.id}/quota`, { method: 'POST' });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.quota.plan, expected.plan);
      assert.equal(body.quota.planKey, expected.key);
      assert.ok(body.quota.quotas.gemini_weekly, 'the shared pools still drive the tab');

      const pool = await (await fetch(`${base}/api/providers/antigravity/accounts?pageSize=200`)).json();
      assert.equal(pool.items.find((item) => item.id === row.id).plan, expected.key);
    }
  } finally {
    await clearAntigravityAccounts();
  }
});

await test('Antigravity tier prefers the Google One plan, with currentTier as fallback', () => {
  // Real Antigravity logins: currentTier stays free-tier, paidTier has the plan.
  assert.equal(antigravityTier({ currentTier: { id: 'free-tier' }, paidTier: { id: 'g1-pro-tier' } }).id, 'g1-pro-tier');
  // A genuinely free account names its starter tier in paidTier, so nothing changes.
  assert.equal(antigravityTier({ currentTier: { id: 'free-tier' }, paidTier: { id: 'free-tier' } }).id, 'free-tier');
  // Code Assist-style logins keep their paid tier in currentTier.
  assert.equal(antigravityTier({ currentTier: { id: 'standard-tier' }, paidTier: { id: 'free-tier' } }).id, 'standard-tier');
  assert.equal(antigravityTier({}), null);
});

await test('Antigravity quota denial does not hide a working account', async () => {
  try {
    const created = await fetch(`${base}/api/providers/antigravity/accounts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Antigravity forbidden quota', access_token: 'ag-quota-forbidden-token' }),
    });
    assert.equal(created.status, 201);
    const row = (await created.json()).items.find((item) => item.label === 'Antigravity forbidden quota');

    const res = await fetch(`${base}/api/providers/antigravity/accounts/${row.id}/quota`, { method: 'POST' });
    const body = await res.json();
    assert.equal(res.status, 403, JSON.stringify(body));
    assert.match(body.error.message, /chat may still work/);
    const pool = await (await fetch(`${base}/api/providers/antigravity/accounts?pageSize=200`)).json();
    const stored = pool.items.find((item) => item.id === row.id);
    assert.equal(stored.status, 'active', 'a quota 403 must not park the account');
  } finally {
    await clearAntigravityAccounts();
  }
});

await test('Antigravity OAuth routes fail closed without client credentials', async () => {
  const status = await fetch(`${base}/api/providers/antigravity/oauth/status/not-a-state`);
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { status: 'unknown' });

  const cancel = await fetch(`${base}/api/providers/antigravity/oauth/cancel/not-a-state`, { method: 'POST' });
  assert.equal(cancel.status, 200);
  assert.deepEqual(await cancel.json(), { cancelled: true });

  // No client id/secret in the environment: fail before opening a browser tab
  // or binding port 1456, with a message naming both variables. Clearing them
  // here matters because importing the server loads .env.
  const savedId = process.env.ANTIGRAVITY_CLIENT_ID;
  const savedSecret = process.env.ANTIGRAVITY_CLIENT_SECRET;
  delete process.env.ANTIGRAVITY_CLIENT_ID;
  delete process.env.ANTIGRAVITY_CLIENT_SECRET;
  try {
    const start = await fetch(`${base}/api/providers/antigravity/oauth/start`, { method: 'POST' });
    const body = await start.json();
    assert.equal(start.status, 409, JSON.stringify(body));
    assert.match(body.error.message, /ANTIGRAVITY_CLIENT_ID/);
    assert.match(body.error.message, /ANTIGRAVITY_CLIENT_SECRET/);
  } finally {
    if (savedId !== undefined) process.env.ANTIGRAVITY_CLIENT_ID = savedId;
    if (savedSecret !== undefined) process.env.ANTIGRAVITY_CLIENT_SECRET = savedSecret;
  }
});

await test('OAuth paste-link validation only accepts the provider callback', () => {
  const provider = { oauth: { fixedPort: 1455, callbackPath: '/auth/callback' } };
  const rejected = [
    '',
    'not a link',
    'https://127.0.0.1:1455/auth/callback?code=x&state=y',
    'http://example.com:1455/auth/callback?code=x&state=y',
    'http://127.0.0.1:1456/auth/callback?code=x&state=y',
    'http://127.0.0.1:1455/callback?code=x&state=y',
    'http://127.0.0.1:1455/auth/callback?code=x',
    `http://127.0.0.1:1455/auth/callback?code=x&state=y&pad=${'a'.repeat(5000)}`,
  ];
  for (const value of rejected) {
    assert.throws(
      () => parseOAuthRedirect(provider, value),
      (err) => err.status === 400 && err.code === 'invalid_oauth_callback',
      `must reject: ${value.slice(0, 48)}`,
    );
  }
  assert.deepEqual(
    parseOAuthRedirect(provider, 'http://localhost:1455/auth/callback?code=abc&state=s1'),
    { state: 's1', code: 'abc', error: '', errorDescription: '' },
    'localhost is the loopback alias the authorize URL uses',
  );
});

await test('OAuth paste-link completion rejects foreign links and unknown states', async () => {
  const complete = (provider, redirectUrl) => fetch(`${base}/api/providers/${provider}/oauth/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirectUrl }),
  });

  const empty = await complete('codex', '');
  assert.equal(empty.status, 400);
  assert.match((await empty.json()).error.message, /Paste the login link/);

  const foreign = await complete('antigravity', 'http://127.0.0.1:1455/auth/callback?code=x&state=y');
  assert.equal(foreign.status, 400);
  assert.match((await foreign.json()).error.message, /localhost:1456\/callback/);

  const unknown = await complete('codex', 'http://127.0.0.1:1455/auth/callback?code=x&state=not-a-pending-state');
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json()).error.message, /state expired or invalid/i);
});

await test('pasted Codex link redeems the code with the pending PKCE verifier', async () => {
  const { createServer: createHttpServer } = await import('node:http');
  const { createHash } = await import('node:crypto');
  const jwt = testJwt({
    email: 'paste-codex@example.com',
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct-paste-codex', chatgpt_plan_type: 'pro' },
  });
  let tokenBody = null;
  const tokenServer = createHttpServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      tokenBody = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        access_token: jwt,
        id_token: jwt,
        refresh_token: 'refresh-paste-codex',
        expires_in: 3600,
      }));
    });
  });
  await new Promise((resolve) => tokenServer.listen(0, '127.0.0.1', resolve));
  // Port 0 keeps the fake callback server off the shared 1455. The pasted URL
  // still has to name the same port, path and state.
  const provider = {
    id: 'codex-paste-test',
    prefix: 'cpt',
    oauth: {
      clientId: 'smoke-codex-client',
      authorizeUrl: 'https://auth.example.test/authorize',
      tokenUrl: `http://127.0.0.1:${tokenServer.address().port}/token`,
      scope: 'openid profile email offline_access',
      codeChallengeMethod: 'S256',
      fixedPort: 0,
      callbackPath: '/auth/callback',
    },
  };
  try {
    const started = await startCodexOAuth(provider);
    const authorize = new URL(started.authorizeUrl);
    assert.equal(authorize.searchParams.get('redirect_uri'), 'http://127.0.0.1:0/auth/callback');
    const challenge = authorize.searchParams.get('code_challenge');
    const pasted = `http://127.0.0.1:0/auth/callback?code=pasted-code&state=${started.state}`;

    const done = await completeCodexOAuth(provider, pasted);
    assert.deepEqual(done, { status: 'complete' });
    assert.equal(oauthStateStatus(started.state), 'complete');
    assert.equal(tokenBody.get('code'), 'pasted-code');
    assert.equal(tokenBody.get('redirect_uri'), 'http://127.0.0.1:0/auth/callback');
    const verifier = tokenBody.get('code_verifier');
    assert.ok(verifier, 'the exchange must send the PKCE verifier');
    assert.equal(
      createHash('sha256').update(verifier).digest('base64url'),
      challenge,
      'the pasted link must reuse the verifier from the start request',
    );

    const account = listAccounts('codex-paste-test', { pageSize: 100 }).items
      .find((row) => row.uid === 'acct-paste-codex');
    assert.ok(account, 'the pasted login must save the Codex account');
    assert.equal(account.plan, 'pro');
    deleteAccount(account.id);

    await assert.rejects(
      completeCodexOAuth(provider, pasted),
      (err) => err.status === 400,
      'a completed state must be consumed exactly once',
    );
  } finally {
    tokenServer.close();
  }
});

await test('pasted Antigravity link resolves the Google plan and project', async () => {
  const { createServer: createHttpServer } = await import('node:http');
  let tokenBody = null;
  let userInfoAuth = '';
  const server = createHttpServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const send = (body) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/token') {
        tokenBody = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        return send({ access_token: 'ya29-paste-token', refresh_token: '1//paste-refresh', expires_in: 3600 });
      }
      if (req.url.startsWith('/userinfo')) {
        userInfoAuth = String(req.headers.authorization || '');
        return send({ email: 'paste-antigravity@example.com' });
      }
      if (req.url === '/loadCodeAssist') {
        return send({
          cloudaicompanionProject: 'project-paste',
          currentTier: { id: 'free-tier' },
          paidTier: { id: 'g1-pro-tier' },
          allowedTiers: [{ id: 'g1-pro-tier', isDefault: true }],
        });
      }
      if (req.url === '/onboardUser') {
        return send({ done: true, response: { cloudaicompanionProject: 'project-paste' } });
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const stubOrigin = `http://127.0.0.1:${server.address().port}`;
  process.env.SMOKE_ANTIGRAVITY_CLIENT_ID = 'smoke-google-client';
  process.env.SMOKE_ANTIGRAVITY_CLIENT_SECRET = 'smoke-google-secret';
  const provider = {
    id: 'antigravity-paste-test',
    prefix: 'apt',
    oauth: {
      clientIdEnv: 'SMOKE_ANTIGRAVITY_CLIENT_ID',
      clientSecretEnv: 'SMOKE_ANTIGRAVITY_CLIENT_SECRET',
      authorizeUrl: 'https://accounts.example.test/authorize',
      tokenUrl: `${stubOrigin}/token`,
      userInfoUrl: `${stubOrigin}/userinfo`,
      loadCodeAssistUrl: `${stubOrigin}/loadCodeAssist`,
      onboardUserUrl: `${stubOrigin}/onboardUser`,
      loadCodeAssistUserAgent: 'smoke-agent',
      scopes: ['openid', 'email'],
      fixedPort: 0,
      callbackPath: '/callback',
    },
  };
  try {
    const started = await startAntigravityOAuth(provider);
    const pasted = `http://localhost:0/callback?code=pasted-google-code&state=${started.state}`;

    const done = await completeAntigravityOAuth(provider, pasted);
    assert.deepEqual(done, { status: 'complete' });
    assert.equal(antigravityOAuthStateStatus(started.state), 'complete');
    assert.equal(tokenBody.get('code'), 'pasted-google-code');
    assert.equal(tokenBody.get('client_secret'), 'smoke-google-secret');
    assert.equal(tokenBody.get('redirect_uri'), 'http://localhost:0/callback');
    assert.equal(userInfoAuth, 'Bearer ya29-paste-token');

    const account = listAccounts('antigravity-paste-test', { pageSize: 100 }).items
      .find((row) => row.uid === 'paste-antigravity@example.com');
    assert.ok(account, 'the pasted login must save the Antigravity account');
    assert.equal(account.plan, 'pro');
    assert.equal(getAccountRow(account.id).project_id, 'project-paste');
    deleteAccount(account.id);
  } finally {
    delete process.env.SMOKE_ANTIGRAVITY_CLIENT_ID;
    delete process.env.SMOKE_ANTIGRAVITY_CLIENT_SECRET;
    server.close();
  }
});


await test('plan vocabulary unifies provider tier names', () => {
  assert.deepEqual(ACCOUNT_PLANS, ['free', 'plus', 'pro', 'ultra', 'team', 'business', 'enterprise', 'unknown']);
  assert.equal(normalizePlan('free-tier'), 'free');
  assert.equal(normalizePlan('legacy-tier'), 'free');
  assert.equal(normalizePlan('g1-plus-tier'), 'plus');
  assert.equal(normalizePlan('g1-pro-tier'), 'pro');
  assert.equal(normalizePlan('g1-ultra-tier'), 'ultra');
  assert.equal(normalizePlan('standard-tier'), 'pro');
  assert.equal(normalizePlan('chatgpt-ultra'), 'ultra');
  assert.equal(normalizePlan('PRO'), 'pro');
  assert.equal(normalizePlan(''), 'unknown');
  assert.equal(normalizePlan(undefined), 'unknown');
  assert.equal(normalizePlan('something-else'), 'unknown');
  assert.equal(planLabel('standard-tier'), 'Pro');
  assert.equal(isKnownPlan('g1-plus-tier'), true);
  assert.equal(isKnownPlan('something-else'), false);
});

await test('a Codex JWT names its account and plan', () => {
  const jwt = testJwt({
    email: 'someone@example.com',
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct-jwt', chatgpt_plan_type: 'plus' },
  });
  assert.deepEqual(identityFromToken(jwt), {
    uid: 'acct-jwt',
    plan: 'plus',
    email: 'someone@example.com',
  });
  assert.equal(identityFromToken(testJwt({ sub: 'sub-only' })), null, 'no auth claim means no identity');
  assert.equal(
    identityFromToken(testJwt({ sub: 'sub-only', 'https://api.openai.com/auth': {} })).uid,
    'sub-only',
  );
  assert.equal(identityFromToken('not-a-jwt'), null);
});

await test('a re-login updates its account instead of adding a twin', () => {
  const first = createAccount('identity-test', {
    access_token: 'relogin-old-access',
    refresh_token: 'relogin-old-refresh',
    uid: 'relogin-uid',
    plan: 'free',
    label: 'Re-login account',
  });
  assert.equal(first.added, 1);

  const second = createAccount('identity-test', {
    access_token: 'relogin-new-access',
    refresh_token: 'relogin-new-refresh',
    uid: 'relogin-uid',
    plan: 'plus',
  }, { updateExisting: true, expiresIn: 3600 });

  assert.equal(second.updated, 1, 'a rotated refresh token must update the existing row');
  assert.equal(second.id, first.id);
  const rows = getDb().prepare(
    "SELECT * FROM accounts WHERE provider = 'identity-test' AND uid = 'relogin-uid'",
  ).all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].refresh_token, 'relogin-new-refresh');
  assert.equal(rows[0].plan, 'plus');
  assert.equal(rows[0].label, 'Re-login account', 'the account keeps its operator-facing label');
  assert.ok(rows[0].expires_at > Date.now());
});

await test('an import preview spots a duplicate identity across rotated tokens', () => {
  const duplicate = previewAccounts('identity-test', [
    { access_token: 'another-rotated-token', uid: 'relogin-uid' },
  ]);
  assert.equal(duplicate.items[0].status, 'duplicate');

  const paste = previewAccounts('identity-test', [
    { access_token: 'paste-a-token', uid: 'paste-uid' },
    { access_token: 'paste-b-token', uid: 'paste-uid' },
  ]);
  assert.equal(paste.items[0].status, 'new');
  assert.equal(paste.items[1].status, 'duplicate_input', 'two tokens for one login in one paste are one account');

  const bulk = bulkCreateAccounts('identity-test', [
    { access_token: 'bulk-a-token', uid: 'bulk-uid' },
    { access_token: 'bulk-b-token', uid: 'bulk-uid' },
  ]);
  assert.equal(bulk.added, 1);
  assert.equal(bulk.duplicates, 1);
  const count = getDb().prepare(
    "SELECT COUNT(*) AS n FROM accounts WHERE provider = 'identity-test' AND uid = 'bulk-uid'",
  ).get().n;
  assert.equal(count, 1);
});

await test('startup backfill recovers Codex identity and plan from stored JWTs', () => {
  const token = testJwt({
    'https://api.openai.com/auth': { chatgpt_account_id: 'backfill-account', chatgpt_plan_type: 'pro' },
  });
  const created = createAccount('codex', { access_token: token, label: 'Backfill identity' });
  assert.equal(created.added, 1);

  const updated = backfillAccountIdentity();
  assert.ok(updated >= 1);
  const row = getDb().prepare('SELECT uid, plan FROM accounts WHERE id = ?').get(created.id);
  assert.equal(row.uid, 'backfill-account');
  assert.equal(row.plan, 'pro');
});

await test('merging duplicate identities keeps usage, counters and models', () => {
  const db = getDb();
  const older = createAccount('merge-test', {
    access_token: 'merge-old-access',
    refresh_token: 'merge-old-refresh',
    uid: 'merge-uid',
    label: 'Merge older',
  });
  const newer = createAccount('merge-test', {
    access_token: 'merge-new-access',
    uid: 'merge-uid',
    plan: 'plus',
    projectId: 'merge-project',
    label: 'Merge newer',
  });
  assert.equal(older.added, 1);
  assert.equal(newer.added, 1);

  db.prepare(`
    UPDATE accounts
       SET requests = 3, tokens_in = 30, tokens_out = 300, last_used_at = 1000
     WHERE id = ?
  `).run(older.id);
  db.prepare(`
    UPDATE accounts
       SET requests = 5, errors = 1, tokens_in = 50, tokens_out = 500,
           last_used_at = 2000, last_error = 'rotated'
     WHERE id = ?
  `).run(newer.id);
  const insertUsage = db.prepare(`
    INSERT INTO account_usage (account_id, day, requests, tokens_in, tokens_out)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertUsage.run(older.id, '2026-01-01', 3, 30, 300);
  insertUsage.run(newer.id, '2026-01-01', 5, 50, 500);
  insertUsage.run(newer.id, '2026-01-02', 4, 40, 400);
  const insertModel = db.prepare(`
    INSERT INTO codex_account_models (account_id, model, plan, updated_at)
    VALUES (?, ?, ?, ?)
  `);
  insertModel.run(older.id, 'gpt-merge-old', 'unknown', Date.now());
  insertModel.run(newer.id, 'gpt-merge-new', 'plus', Date.now());

  const merged = mergeDuplicateAccounts();
  assert.ok(merged >= 1);

  const rows = db.prepare("SELECT * FROM accounts WHERE provider = 'merge-test'").all();
  assert.equal(rows.length, 1);
  const survivor = rows[0];
  // The row that can still refresh is the one kept.
  assert.equal(survivor.id, older.id);
  assert.equal(survivor.plan, 'plus');
  assert.equal(survivor.project_id, 'merge-project');
  assert.equal(survivor.requests, 8);
  assert.equal(survivor.errors, 1);
  assert.equal(survivor.tokens_in, 80);
  assert.equal(survivor.tokens_out, 800);
  assert.equal(survivor.last_used_at, 2000);

  const usage = db.prepare(
    'SELECT day, requests FROM account_usage WHERE account_id = ? ORDER BY day',
  ).all(survivor.id);
  assert.deepEqual(usage.map((row) => [row.day, row.requests]), [['2026-01-01', 8], ['2026-01-02', 4]]);
  const models = db.prepare(
    'SELECT model FROM codex_account_models WHERE account_id = ? ORDER BY model',
  ).all(survivor.id).map((row) => row.model);
  assert.deepEqual(models, ['gpt-merge-new', 'gpt-merge-old']);
});

await test('the identity index enforces one row per provider login', () => {
  assert.equal(ensureAccountIdentityIndex(), true);
  const duplicate = createAccount('merge-test', {
    access_token: 'merge-third-access',
    uid: 'merge-uid',
    label: 'Merge third',
  });
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.error, /already in the pool/);
  const count = getDb().prepare(
    "SELECT COUNT(*) AS n FROM accounts WHERE provider = 'merge-test' AND uid = 'merge-uid'",
  ).get().n;
  assert.equal(count, 1);
});

// The exact string seen in the ZCode transcript: Upstage's parser missed the
// call and the model's native tokens landed in `content` as prose.
const LEAKED_READ =
  '<|tool_callstart|>Read <|tool_orgstart|>file_path <|tool_argvalue|>F:\\Project\\windowsisland\\src-tauri\\src\\main.rs<|tool_argend|> <|tool_callend|>';
const READ_TOOL = {
  type: 'function',
  function: { name: 'Read', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } },
};

await test('native tool tokens in content are recovered as a tool call', () => {
  const parsed = parseNativeToolCalls(LEAKED_READ, [READ_TOOL]);
  assert.ok(parsed);
  assert.equal(parsed.calls.length, 1);
  assert.equal(parsed.calls[0].function.name, 'Read');
  assert.deepEqual(JSON.parse(parsed.calls[0].function.arguments), {
    file_path: 'F:\\Project\\windowsisland\\src-tauri\\src\\main.rs',
  });
  assert.equal(parsed.text.trim(), '');
});

await test('multiple native calls and schema coercion survive', () => {
  const text =
    'Running two commands.\n' +
    '<|tool_callstart|>Bash <|tool_orgstart|>command <|tool_argvalue|>pwd<|tool_argend|>' +
    '<|tool_orgstart|>timeout <|tool_argvalue|>30<|tool_argend|><|tool_callend|>' +
    ' then <|tool_callstart|>Bash <|tool_orgstart|>command <|tool_argvalue|>ls<|tool_argend|><|tool_callend|>';
  const tools = [{
    type: 'function',
    function: { name: 'Bash', parameters: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'integer' } } } },
  }];
  const parsed = parseNativeToolCalls(text, tools);
  assert.ok(parsed);
  assert.equal(parsed.calls.length, 2);
  assert.deepEqual(JSON.parse(parsed.calls[0].function.arguments), { command: 'pwd', timeout: 30 });
  assert.deepEqual(JSON.parse(parsed.calls[1].function.arguments), { command: 'ls' });
  assert.equal(parsed.text.trim(), 'Running two commands.\n then');
});

await test('an undeclared native tool name stays plain text', () => {
  assert.equal(parseNativeToolCalls(LEAKED_READ, [{ type: 'function', function: { name: 'Bash' } }]), null);
  assert.equal(parseNativeToolCalls(LEAKED_READ.slice(0, -3), [READ_TOOL]), null, 'a truncated block is not a call');
  assert.equal(parseNativeToolCalls('just prose', [READ_TOOL]), null);
});

await test('non-stream payloads move the recovered call onto message.tool_calls', () => {
  const payload = {
    choices: [{
      index: 0,
      message: { role: 'assistant', content: LEAKED_READ },
      finish_reason: 'stop',
    }],
  };
  assert.equal(recoverNativeToolCalls(payload, [READ_TOOL]), true);
  assert.equal(payload.choices[0].message.content, null);
  assert.equal(payload.choices[0].message.tool_calls[0].function.name, 'Read');
  assert.equal(payload.choices[0].finish_reason, 'tool_calls');

  const plain = { choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }] };
  assert.equal(recoverNativeToolCalls(plain, [READ_TOOL]), false);
  assert.equal(plain.choices[0].message.content, 'hi');
});

await test('streaming recovers native calls split across chunks', () => {
  const stream = createNativeToolStream([READ_TOOL]);
  const acc = createAccumulator();
  const pieces = [
    '<|tool_call',
    'start|>Read <|tool_orgstart|>file_path <|tool_argvalue|>F:\\Pro',
    'ject\\a.rs<|tool_argend|> <|tool_callend|>',
  ];
  for (const piece of pieces) {
    const chunk = { choices: [{ index: 0, delta: { content: piece } }] };
    stream.apply(chunk);
    acc.feed(chunk);
  }
  const finish = { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
  stream.apply(finish);
  acc.feed(finish);

  const completion = acc.toCompletion('x');
  assert.equal(completion.choices[0].finish_reason, 'tool_calls');
  assert.equal(completion.choices[0].message.content, null);
  assert.equal(completion.choices[0].message.tool_calls.length, 1);
  assert.equal(completion.choices[0].message.tool_calls[0].function.name, 'Read');
  assert.deepEqual(JSON.parse(completion.choices[0].message.tool_calls[0].function.arguments), {
    file_path: 'F:\\Project\\a.rs',
  });
});

await test('streaming leaves ordinary content and unknown blocks untouched', () => {
  const stream = createNativeToolStream([READ_TOOL]);
  const plain = { choices: [{ index: 0, delta: { content: 'hello <|not a token|> world' } }] };
  assert.equal(stream.apply(plain), false);
  assert.equal(plain.choices[0].delta.content, 'hello <|not a token|> world');

  const unknown = { choices: [{ index: 0, delta: { content: LEAKED_READ.replace('Read', 'Nope') } }] };
  assert.equal(stream.apply(unknown), false);
  assert.equal(unknown.choices[0].delta.content, LEAKED_READ.replace('Read', 'Nope'), 'restored verbatim');
  assert.deepEqual(stream.finish(), []);
});

await test('a leaked native tool call is recovered end to end', async () => {
  const id = `native-leak-${Date.now()}`;
  const create = await fetch(`${base}/api/providers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `Native leak ${id}`,
      id,
      baseUrl: `${stubBase}/v2`,
      models: 'native-leak',
    }),
  });
  assert.equal(create.status, 201);
  // The stub rejects unauthenticated upstreams, so give the test provider one
  // pooled account instead of relying on an open endpoint.
  const account = await fetch(`${base}/api/providers/${id}/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accessToken: 'stub-native-token', label: 'stub' }),
  });
  assert.equal(account.status, 201);
  const tools = [READ_TOOL];
  try {
    const request = (stream) => fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: `${id}/native-leak`,
        messages: [{ role: 'user', content: 'open main.rs' }],
        tools,
        stream,
      }),
    });

    const nonStream = await request(false);
    assert.equal(nonStream.status, 200);
    const payload = await nonStream.json();
    assert.equal(payload.choices[0].finish_reason, 'tool_calls');
    assert.equal(payload.choices[0].message.content, null);
    assert.equal(payload.choices[0].message.tool_calls[0].function.name, 'Read');
    assert.deepEqual(JSON.parse(payload.choices[0].message.tool_calls[0].function.arguments), {
      file_path: 'F:\\Project\\app\\main.rs',
    });

    const streamed = await request(true);
    assert.equal(streamed.status, 200);
    const text = await streamed.text();
    assert.doesNotMatch(text, /<\|tool_/, 'no native tokens reach the client');
    const acc = createAccumulator();
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      acc.feed(JSON.parse(data));
    }
    const completion = acc.toCompletion('x');
    assert.equal(completion.choices[0].finish_reason, 'tool_calls');
    assert.match(completion.choices[0].message.content, /Thinking\./);
    assert.equal(completion.choices[0].message.tool_calls[0].function.name, 'Read');
    assert.deepEqual(JSON.parse(completion.choices[0].message.tool_calls[0].function.arguments), {
      file_path: 'F:\\Project\\app\\main.rs',
    });
  } finally {
    const del = await fetch(`${base}/api/providers/${id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
  }
});

// The relay is shared by every wire, so each wire gets a provider that points
// at a stub fixture which cuts the stream. A cut turn must surface as an error
// frame (or a 502 when nothing was sent yet), never as a fake success.
async function createWireProvider({ id, format = 'openai', forceStream = false, models }) {
  const created = await fetch(`${base}/api/providers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `Stream wire ${id}`,
      id,
      baseUrl: `${stubBase}/v2`,
      models,
      format,
      forceStream,
    }),
  });
  const body = await created.text();
  assert.equal(created.status, 201, body);
  // The stub rejects unauthenticated upstreams, so the provider needs one
  // pooled account even though it is otherwise open.
  const account = await fetch(`${base}/api/providers/${id}/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accessToken: `stub-${id}-token`, label: 'stub' }),
  });
  assert.equal(account.status, 201, await account.text());
}

async function dropWireProvider(id) {
  const res = await fetch(`${base}/api/providers/${id}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
}

async function wireTotals(id) {
  const res = await fetch(`${base}/api/providers/${id}/usage?range=day`);
  assert.equal(res.status, 200);
  return (await res.json()).totals;
}

function wireChat(model, { stream = true } = {}) {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream, messages: [{ role: 'user', content: 'halo' }] }),
  });
}

await test('a stream cut before a finish signal is reported as truncated', async () => {
  const id = `wire-openai-${Date.now()}`;
  await createWireProvider({ id, models: 'truncated-openai,truncated-final-frame,json-error-body,glm-5.3-flash' });
  try {
    const before = await wireTotals(id);
    const res = await wireChat(`${id}/truncated-openai`);
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.match(text, /"code":"stream_truncated"/);
    assert.match(text, /stream ended before completion/i);
    assert.match(text, /half an ans/, 'bytes received before the cut still reach the client');
    assert.doesNotMatch(text, /\[DONE\]/, 'a truncated turn must not look finished');
    const after = await wireTotals(id);
    assert.equal(after.errors, before.errors + 1);
    assert.equal(after.requests, before.requests, 'a truncated turn is not a served request');
  } finally {
    await dropWireProvider(id);
  }
});

await test('a final frame without its newline still completes the stream', async () => {
  const id = `wire-final-${Date.now()}`;
  await createWireProvider({ id, models: 'truncated-final-frame' });
  try {
    const before = await wireTotals(id);
    const res = await wireChat(`${id}/truncated-final-frame`);
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.match(text, /complete answer/);
    assert.match(text, /"finish_reason":"stop"/);
    assert.ok(text.endsWith('data: [DONE]\n\n'), 'the finish frame and sentinel must stay separate');
    assert.doesNotMatch(text, /stream_truncated/);
    const after = await wireTotals(id);
    assert.equal(after.requests, before.requests + 1);
    assert.equal(after.errors, before.errors);
  } finally {
    await dropWireProvider(id);
  }
});

await test('an in-stream upstream error does not end as success', async () => {
  const id = `wire-error-${Date.now()}`;
  await createWireProvider({ id, models: 'glm-5.3-flash' });
  try {
    const before = await wireTotals(id);
    const res = await wireChat(`${id}/glm-5.3-flash`);
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.match(text, /"code":"stream_error"/);
    assert.match(text, /stub quota exhausted/);
    assert.doesNotMatch(text, /\[DONE\]/);
    const after = await wireTotals(id);
    assert.equal(after.errors, before.errors + 1);
    assert.equal(after.requests, before.requests);
  } finally {
    await dropWireProvider(id);
  }
});

await test('a 200 JSON error body is relayed as an upstream failure', async () => {
  const id = `wire-json-error-${Date.now()}`;
  await createWireProvider({ id, models: 'json-error-body' });
  try {
    const before = await wireTotals(id);
    const res = await wireChat(`${id}/json-error-body`, { stream: false });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.type, 'upstream_error');
    assert.match(body.error.message, /upstream refused the turn/);
    const after = await wireTotals(id);
    assert.equal(after.errors, before.errors + 1);
    assert.equal(after.requests, before.requests);
  } finally {
    await dropWireProvider(id);
  }
});

await test('a force-stream upstream that cuts off fails the buffered turn', async () => {
  const id = `wire-buffered-${Date.now()}`;
  await createWireProvider({ id, forceStream: true, models: 'truncated-openai' });
  try {
    const before = await wireTotals(id);
    const res = await wireChat(`${id}/truncated-openai`, { stream: false });
    assert.equal(res.status, 502, 'nothing reached the client yet, so this is a real 502');
    const body = await res.json();
    assert.match(body.error.message, /stream ended before completion/i);
    const after = await wireTotals(id);
    assert.equal(after.errors, before.errors + 1);
    assert.equal(after.requests, before.requests);
  } finally {
    await dropWireProvider(id);
  }
});

await test('the Responses wire reports truncation and keeps intentional endings', async () => {
  const id = `wire-responses-${Date.now()}`;
  await createWireProvider({
    id,
    format: 'responses',
    models: 'responses-truncated,responses-completed-no-newline,responses-incomplete',
  });
  try {
    const before = await wireTotals(id);
    const truncated = await wireChat(`${id}/responses-truncated`);
    const truncatedText = await truncated.text();
    assert.equal(truncated.status, 200);
    assert.match(truncatedText, /"code":"stream_truncated"/);
    assert.doesNotMatch(truncatedText, /\[DONE\]/);

    const completed = await wireChat(`${id}/responses-completed-no-newline`);
    const completedText = await completed.text();
    assert.equal(completed.status, 200);
    assert.match(completedText, /responses-completed-no-newline Responses model\./);
    assert.match(completedText, /"finish_reason":"stop"/);
    assert.ok(completedText.endsWith('data: [DONE]\n\n'));

    const incomplete = await wireChat(`${id}/responses-incomplete`);
    const incompleteText = await incomplete.text();
    assert.equal(incomplete.status, 200);
    assert.match(incompleteText, /responses-incomplete Responses model\./);
    assert.ok(incompleteText.endsWith('data: [DONE]\n\n'), 'a deliberate ending is not truncation');
    assert.doesNotMatch(incompleteText, /"code":"stream_truncated"/);

    const after = await wireTotals(id);
    assert.equal(after.requests, before.requests + 2, 'only the two completed turns are served');
    assert.equal(after.errors, before.errors + 1);
  } finally {
    await dropWireProvider(id);
  }
});

await test('the Anthropic wire reports a stream cut before message_delta', async () => {
  const id = `wire-anthropic-${Date.now()}`;
  await createWireProvider({ id, format: 'anthropic', models: 'anthropic-truncated' });
  try {
    const before = await wireTotals(id);
    const res = await wireChat(`${id}/anthropic-truncated`);
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.match(text, /"code":"stream_truncated"/);
    // This wire streams word by word, so the sentence is never one frame.
    assert.match(text, /"content":"I "/);
    assert.match(text, /"content":"anthropic-truncated "/);
    assert.match(text, /"content":"model\. "/);
    assert.doesNotMatch(text, /\[DONE\]/);
    const after = await wireTotals(id);
    assert.equal(after.errors, before.errors + 1);
    assert.equal(after.requests, before.requests);
  } finally {
    await dropWireProvider(id);
  }
});

await test('the Antigravity wire reports a candidate cut before finishReason', async () => {
  await clearAntigravityAccounts();
  try {
    const created = await fetch(`${base}/api/providers/antigravity/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Antigravity truncated', access_token: 'ag-stream-token', projectId: 'stub-project' }),
    });
    assert.equal(created.status, 201, await created.text());
    const before = await wireTotals('antigravity');
    const res = await wireChat('ag/gemini-3.5-flash-lite');
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.match(text, /"code":"stream_truncated"/);
    assert.match(text, /half an ans/);
    assert.doesNotMatch(text, /\[DONE\]/);
    const after = await wireTotals('antigravity');
    assert.equal(after.errors, before.errors + 1);
    assert.equal(after.requests, before.requests);
  } finally {
    await clearAntigravityAccounts();
  }
});

await test('a truncated first combo model never reaches the second model', async () => {
  const id = `wire-combo-${Date.now()}`;
  const comboName = `truncated-chain-${Date.now()}`;
  await createWireProvider({ id, models: 'truncated-openai,truncated-final-frame' });
  let comboId = null;
  try {
    const create = await fetch(`${base}/api/combos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: comboName,
        models: [`${id}/truncated-openai`, `${id}/truncated-final-frame`],
      }),
    });
    const created = await create.json();
    assert.equal(create.status, 201, JSON.stringify(created));
    comboId = created.combo.id;

    const before = stubCalls.length;
    const res = await wireChat(comboName);
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.match(text, /"code":"stream_truncated"/);
    assert.doesNotMatch(text, /complete answer/, 'the second model must not run after headers were sent');
    assert.doesNotMatch(text, /\[DONE\]/);
    assert.deepEqual(stubCalls.slice(before), ['truncated-openai']);
  } finally {
    if (comboId) await fetch(`${base}/api/combos/${encodeURIComponent(comboId)}`, { method: 'DELETE' });
    await dropWireProvider(id);
  }
});

// The inbound Responses route translates down to the chat pipeline and
// rebuilds the reply, so these tests check the client-visible event stream and
// that routing (including vision) still happens on the converted request.
function collectResponsesEvents(text) {
  const events = [];
  for (const block of text.split('\n\n')) {
    const lines = block.split('\n');
    const type = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
    const data = lines.find((line) => line.startsWith('data:'))?.slice(5).trim();
    if (!type || !data) continue;
    events.push({ type, data: JSON.parse(data) });
  }
  return events;
}

function postResponses(payload) {
  return fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

await test('inbound /v1/responses streams Responses events instead of chat chunks', async () => {
  const id = `inbound-${Date.now()}`;
  await createWireProvider({ id, models: 'inbound-plain' });
  try {
    const res = await postResponses({ model: `${id}/inbound-plain`, input: 'halo', stream: true });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
    const events = collectResponsesEvents(text);
    assert.ok(events.length > 3, 'a stream must arrive as several Responses events');
    for (const event of events) assert.equal(event.type, event.data.type, 'event: and data.type must agree');
    assert.equal(events[0].type, 'response.created');
    assert.ok(events.some((event) => event.type === 'response.output_text.delta'));
    assert.equal(events.at(-1).type, 'response.completed');
    assert.ok(!events.some((event) => event.type === 'response.failed'));
    assert.doesNotMatch(text, /\[DONE\]/, 'a Responses stream carries no chat sentinel');

    const completed = events.at(-1).data.response;
    assert.equal(completed.status, 'completed');
    assert.equal(completed.model, 'inbound-plain');
    assert.match(completed.output[0].content[0].text, /stub reply for inbound-plain/);
    assert.ok(completed.usage.input_tokens > 0 && completed.usage.output_tokens > 0);

    const forwarded = chatBodies.at(-1);
    assert.equal(forwarded.messages.filter((message) => message.role === 'user').at(-1).content, 'halo');
    assert.equal(forwarded.stream, true);
  } finally {
    await dropWireProvider(id);
  }
});

await test('inbound /v1/responses rebuilds streamed tool calls', async () => {
  const id = `inbound-tool-${Date.now()}`;
  await createWireProvider({ id, models: 'reasoning-empty-tools,tool-late-name' });
  try {
    const res = await postResponses({ model: `${id}/reasoning-empty-tools`, input: 'think', stream: true });
    const events = collectResponsesEvents(await res.text());
    const added = events.find((event) => event.type === 'response.output_item.added' && event.data.item?.type === 'function_call');
    assert.ok(added, 'the function call item must be announced');
    assert.equal(added.data.item.name, 'stub_tool');
    const done = events.find((event) => event.type === 'response.output_item.done' && event.data.item?.type === 'function_call');
    assert.ok(done, 'the function call item must close');
    assert.equal(done.data.item.arguments, '{}');
    assert.equal(events.at(-1).type, 'response.completed');
    const completed = events.at(-1).data.response;
    const call = completed.output.find((item) => item.type === 'function_call');
    assert.equal(call.call_id, 'call_stub');
    assert.equal(call.name, 'stub_tool');
    assert.ok(completed.output.some((item) => item.type === 'message'), 'text before the call stays a message item');

    // Argument fragments that arrive before the function name must be kept.
    const late = await postResponses({ model: `${id}/tool-late-name`, input: 'weather', stream: true });
    const lateEvents = collectResponsesEvents(await late.text());
    const lateCall = lateEvents.at(-1).data.response.output.find((item) => item.type === 'function_call');
    assert.equal(lateCall.name, 'get_weather');
    assert.equal(lateCall.arguments, '{"city":"Jakarta","unit":"celsius"}');
    const streamed = lateEvents
      .filter((event) => event.type === 'response.function_call_arguments.delta')
      .map((event) => event.data.delta)
      .join('');
    assert.equal(streamed, '{"city":"Jakarta","unit":"celsius"}');
  } finally {
    await dropWireProvider(id);
  }
});

await test('inbound /v1/responses turns an upstream stream error into response.failed', async () => {
  const id = `inbound-err-${Date.now()}`;
  await createWireProvider({ id, models: 'glm-5.3-flash' });
  try {
    const res = await postResponses({ model: `${id}/glm-5.3-flash`, input: 'hi', stream: true });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const events = collectResponsesEvents(text);
    assert.equal(events.filter((event) => event.type === 'response.failed').length, 1, 'one terminal failure event');
    const failed = events.at(-1);
    assert.equal(failed.type, 'response.failed');
    assert.equal(failed.data.response.status, 'failed');
    assert.match(failed.data.error.message, /quota exhausted/);
    assert.ok(!events.some((event) => event.type === 'response.completed'), 'no fake finish after the failure');
    assert.doesNotMatch(text, /\[DONE\]/);
  } finally {
    await dropWireProvider(id);
  }
});

await test('inbound /v1/responses returns a Responses object when not streaming', async () => {
  const id = `inbound-json-${Date.now()}`;
  await createWireProvider({ id, format: 'responses', models: 'responses-plain' });
  try {
    const res = await postResponses({ model: `${id}/responses-plain`, input: 'halo' });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.object, 'response');
    assert.equal(body.status, 'completed');
    assert.equal(body.output[0].type, 'message');
    assert.equal(body.output[0].role, 'assistant');
    assert.match(body.output[0].content[0].text, /Responses model/);
    assert.equal(body.usage.input_tokens, 11);
    assert.equal(body.usage.output_tokens, 7);
    assert.equal(body.usage.total_tokens, 18);
  } finally {
    await dropWireProvider(id);
  }
});

await test('inbound /v1/responses keeps image input on the vision chain', async () => {
  const created = await fetch(`${base}/api/providers/codebuddy-cn/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Responses vision account', access_token: 'responses-vision-token' }),
  });
  assert.equal(created.status, 201);
  const patch = (payload) => fetch(`${base}/api/vision-routing`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  try {
    const saved = await patch({ enabled: true, strategy: 'order', models: ['cbcn/deepseek-v4.1-flash'] });
    assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));

    stubCalls.length = 0;
    const res = await postResponses({
      model: 'cbcn/glm-5.3',
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: 'what is this?' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
        ],
      }],
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.deepEqual(stubCalls, ['deepseek-v4.1-flash'], 'input_image must trigger the vision chain');
    assert.match(body.output[0].content[0].text, /stub reply for deepseek-v4\.1-flash/);

    const log = (await (await fetch(`${base}/api/request-log`)).json()).requests.at(-1);
    assert.equal(log.route, 'vision');
    assert.equal(log.image, true);
    assert.equal(log.requested, 'cbcn/glm-5.3');
  } finally {
    await patch({ enabled: false, strategy: 'order', models: [] });
    const pool = await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json();
    for (const row of pool.items.filter((item) => item.label === 'Responses vision account')) {
      await fetch(`${base}/api/providers/codebuddy-cn/accounts/${row.id}`, { method: 'DELETE' });
    }
  }
});

await test('inbound /v1/responses rejects fields it cannot honor', async () => {
  const previous = await postResponses({ model: 'cbcn/glm-5.3', previous_response_id: 'resp_1', input: 'hi' });
  assert.equal(previous.status, 400);
  assert.match((await previous.json()).error.message, /previous_response_id/);

  const tool = await postResponses({ model: 'cbcn/glm-5.3', input: 'hi', tools: [{ type: 'web_search' }] });
  assert.equal(tool.status, 400);
  assert.match((await tool.json()).error.message, /function tools/i);

  const missing = await postResponses({ model: 'cbcn/glm-5.3' });
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error.message, /requires input/);
});

// Inbound Anthropic Messages follows the same deferred-header sink design as
// Responses, so these tests focus on the rebuilt event stream and on the chat
// body the request was translated into.
const postMessages = (payload) => fetch(`${base}/v1/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});

// Anthropic SSE uses the same `event:` + `data:` framing as the Responses
// stream, so the existing parser is enough.
const collectMessagesEvents = collectResponsesEvents;

await test('inbound /v1/messages streams Messages events instead of chat chunks', async () => {
  const id = `inbound-msg-${Date.now()}`;
  await createWireProvider({ id, models: 'inbound-plain' });
  try {
    const res = await postMessages({
      model: `${id}/inbound-plain`,
      max_tokens: 64,
      system: 'Be brief.',
      messages: [{ role: 'user', content: 'halo' }],
      stream: true,
    });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
    const events = collectMessagesEvents(text);
    assert.ok(events.length > 3, 'a stream must arrive as several Messages events');
    for (const event of events) assert.equal(event.type, event.data.type, 'event: and data.type must agree');
    assert.equal(events[0].type, 'message_start');
    assert.equal(events[0].data.message.role, 'assistant');
    assert.equal(events[0].data.message.model, 'inbound-plain');
    assert.equal(events.filter((event) => event.type === 'content_block_start').length, 1);
    assert.equal(events.filter((event) => event.type === 'content_block_delta').length > 1, true);
    const deltas = events
      .filter((event) => event.type === 'content_block_delta' && event.data.delta.type === 'text_delta')
      .map((event) => event.data.delta.text)
      .join('');
    assert.match(deltas, /stub reply for inbound-plain/);
    const final = events.find((event) => event.type === 'message_delta');
    assert.equal(final.data.delta.stop_reason, 'end_turn');
    assert.ok(final.data.usage.output_tokens > 0);
    assert.equal(events.at(-1).type, 'message_stop');
    assert.doesNotMatch(text, /\[DONE\]/, 'a Messages stream carries no chat sentinel');

    const forwarded = chatBodies.at(-1);
    const system = forwarded.messages.find((message) => message.role === 'system');
    assert.ok(system.content.startsWith('Be brief.'));
    const user = forwarded.messages.filter((message) => message.role === 'user').at(-1);
    assert.deepEqual(user.content, [{ type: 'text', text: 'halo' }]);
    assert.equal(forwarded.max_tokens, 64);
    assert.equal(forwarded.stream, true);
  } finally {
    await dropWireProvider(id);
  }
});

await test('inbound /v1/messages rebuilds streamed tool calls', async () => {
  const id = `inbound-msg-tool-${Date.now()}`;
  await createWireProvider({ id, models: 'reasoning-empty-tools,tool-late-name' });
  try {
    const res = await postMessages({
      model: `${id}/reasoning-empty-tools`,
      max_tokens: 128,
      messages: [{ role: 'user', content: 'think' }],
      stream: true,
    });
    const events = collectMessagesEvents(await res.text());
    const start = events.find((event) => event.type === 'content_block_start' && event.data.content_block.type === 'thinking');
    assert.ok(start, 'reasoning must stream as a thinking block');
    const text = events.find((event) => event.type === 'content_block_start' && event.data.content_block.type === 'text');
    assert.ok(text, 'visible text gets its own block');
    const tool = events.find((event) => event.type === 'content_block_start' && event.data.content_block.type === 'tool_use');
    assert.ok(tool, 'the function call becomes a tool_use block');
    assert.equal(tool.data.content_block.name, 'stub_tool');
    assert.equal(tool.data.content_block.id, 'call_stub');
    const input = events.find((event) => event.type === 'content_block_delta' && event.data.delta.type === 'input_json_delta');
    assert.equal(input.data.delta.partial_json, '{}');
    assert.equal(events.find((event) => event.type === 'message_delta').data.delta.stop_reason, 'tool_use');
    assert.equal(events.at(-1).type, 'message_stop');

    // Argument fragments that arrive before the function name must be kept.
    const late = await postMessages({
      model: `${id}/tool-late-name`,
      max_tokens: 128,
      messages: [{ role: 'user', content: 'weather' }],
      stream: true,
    });
    const lateEvents = collectMessagesEvents(await late.text());
    const lateTool = lateEvents.find((event) => event.type === 'content_block_start' && event.data.content_block.type === 'tool_use');
    assert.equal(lateTool.data.content_block.name, 'get_weather');
    const partial = lateEvents
      .filter((event) => event.type === 'content_block_delta' && event.data.delta.type === 'input_json_delta')
      .map((event) => event.data.delta.partial_json)
      .join('');
    assert.equal(partial, '{"city":"Jakarta","unit":"celsius"}');
    assert.equal(lateEvents.find((event) => event.type === 'message_delta').data.delta.stop_reason, 'tool_use');
  } finally {
    await dropWireProvider(id);
  }
});

await test('inbound /v1/messages turns an upstream stream error into one error event', async () => {
  const id = `inbound-msg-err-${Date.now()}`;
  await createWireProvider({ id, models: 'glm-5.3-flash' });
  try {
    const res = await postMessages({
      model: `${id}/glm-5.3-flash`,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const events = collectMessagesEvents(text);
    assert.equal(events.filter((event) => event.type === 'error').length, 1, 'one terminal error event');
    const error = events.at(-1);
    assert.equal(error.type, 'error');
    assert.equal(error.data.error.type, 'rate_limit_error');
    assert.match(error.data.error.message, /quota exhausted/);
    assert.ok(!events.some((event) => event.type === 'message_stop'), 'no fake finish after the failure');
    assert.ok(!events.some((event) => event.type === 'message_delta'));
    assert.doesNotMatch(text, /\[DONE\]/);
  } finally {
    await dropWireProvider(id);
  }
});

await test('inbound /v1/messages returns a message object when not streaming', async () => {
  const id = `inbound-msg-json-${Date.now()}`;
  await createWireProvider({ id, models: 'inbound-plain,reasoning-empty-tools' });
  try {
    const res = await postMessages({
      model: `${id}/inbound-plain`,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'halo' }],
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.type, 'message');
    assert.equal(body.role, 'assistant');
    assert.equal(body.content[0].type, 'text');
    assert.match(body.content[0].text, /stub reply for inbound-plain/);
    assert.equal(body.stop_reason, 'end_turn');
    assert.ok(body.usage.input_tokens > 0 && body.usage.output_tokens > 0);

    const toolRes = await postMessages({
      model: `${id}/reasoning-empty-tools`,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'think' }],
    });
    const toolBody = await toolRes.json();
    assert.equal(toolRes.status, 200, JSON.stringify(toolBody));
    assert.equal(toolBody.content[0].text, 'Done.');
    const call = toolBody.content.find((block) => block.type === 'tool_use');
    assert.equal(call.name, 'stub_tool');
    assert.deepEqual(call.input, {});
    assert.equal(toolBody.stop_reason, 'tool_use');
  } finally {
    await dropWireProvider(id);
  }
});

await test('inbound /v1/messages replays history, tools, and sampling fields', async () => {
  const id = `inbound-msg-hist-${Date.now()}`;
  await createWireProvider({ id, models: 'inbound-plain' });
  const tools = [{
    name: 'get_weather',
    description: 'Weather',
    input_schema: { type: 'object', properties: { city: { type: 'string' } } },
  }];
  try {
    const res = await postMessages({
      model: `${id}/inbound-plain`,
      max_tokens: 64,
      temperature: 0.2,
      stop_sequences: ['END'],
      messages: [
        { role: 'user', content: 'weather in Jakarta?' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'need a tool' },
            { type: 'text', text: 'Let me check.' },
            { type: 'tool_use', id: 'toolu_hist', name: 'get_weather', input: { city: 'Jakarta' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_hist', content: '{"temp":30}' }],
        },
      ],
      tools,
      tool_choice: { type: 'any' },
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));

    const forwarded = chatBodies.at(-1);
    const assistant = forwarded.messages.find((message) => message.role === 'assistant');
    assert.equal(assistant.content, 'Let me check.');
    assert.deepEqual(assistant.tool_calls, [{
      id: 'toolu_hist',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"Jakarta"}' },
    }]);
    const tool = forwarded.messages.find((message) => message.role === 'tool');
    assert.equal(tool.tool_call_id, 'toolu_hist');
    assert.equal(tool.content, '{"temp":30}');
    assert.ok(!forwarded.messages.some((message) => JSON.stringify(message).includes('need a tool')), 'thinking blocks are dropped');
    assert.deepEqual(forwarded.tools, [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    }]);
    assert.equal(forwarded.tool_choice, 'required');
    assert.deepEqual(forwarded.stop, ['END']);
    assert.equal(forwarded.temperature, 0.2);
  } finally {
    await dropWireProvider(id);
  }
});

await test('inbound /v1/messages keeps image input on the vision chain', async () => {
  const created = await fetch(`${base}/api/providers/codebuddy-cn/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Messages vision account', access_token: 'messages-vision-token' }),
  });
  assert.equal(created.status, 201);
  const patch = (payload) => fetch(`${base}/api/vision-routing`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  try {
    const saved = await patch({ enabled: true, strategy: 'order', models: ['cbcn/deepseek-v4.1-flash'] });
    assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));

    stubCalls.length = 0;
    const res = await postMessages({
      model: 'cbcn/glm-5.3',
      max_tokens: 64,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ],
      }],
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.deepEqual(stubCalls, ['deepseek-v4.1-flash'], 'image blocks must trigger the vision chain');
    assert.match(body.content[0].text, /stub reply for deepseek-v4\.1-flash/);

    const log = (await (await fetch(`${base}/api/request-log`)).json()).requests.at(-1);
    assert.equal(log.route, 'vision');
    assert.equal(log.image, true);
    assert.equal(log.requested, 'cbcn/glm-5.3');
  } finally {
    await patch({ enabled: false, strategy: 'order', models: [] });
    const pool = await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json();
    for (const row of pool.items.filter((item) => item.label === 'Messages vision account')) {
      await fetch(`${base}/api/providers/codebuddy-cn/accounts/${row.id}`, { method: 'DELETE' });
    }
  }
});

await test('inbound /v1/messages rejects requests it cannot translate', async () => {
  const cases = [
    [{ model: 'cbcn/glm-5.3', max_tokens: 16 }, /at least one message/],
    [{ model: 'cbcn/glm-5.3', max_tokens: 0, messages: [{ role: 'user', content: 'hi' }] }, /max_tokens/],
    [{ model: 'cbcn/glm-5.3', max_tokens: 16, messages: [{ role: 'user', content: [{ type: 'tool_use', name: 'x' }] }] }, /Unsupported user content block/],
    [{
      model: 'cbcn/glm-5.3',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    }, /function tools/i],
    [{
      model: 'cbcn/glm-5.3',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'get_weather' }],
      tool_choice: { type: 'weird' },
    }, /tool_choice/],
    [{
      model: 'cbcn/glm-5.3',
      max_tokens: 16,
      messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'x' }] }],
    }, /tool_use_id/],
  ];
  for (const [payload, pattern] of cases) {
    const res = await postMessages(payload);
    const body = await res.json();
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(body.type, 'error');
    assert.equal(body.error.type, 'invalid_request_error');
    assert.match(body.error.message, pattern);
  }
});

// Two helpers the routing-rule tests share: a clean credential pool (the 429
// fixture parks one account) and the settings endpoint.
async function resetCodebuddyAccounts(tokens) {
  for (;;) {
    const page = await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json();
    if (!page.items.length) break;
    for (const row of page.items) {
      await fetch(`${base}/api/providers/codebuddy-cn/accounts/${row.id}`, { method: 'DELETE' });
    }
  }
  for (const token of tokens) {
    const res = await fetch(`${base}/api/providers/codebuddy-cn/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: `Routing ${token}`, access_token: token }),
    });
    assert.equal(res.status, 201, `account ${token} must be created`);
  }
}

function patchRoutingRules(payload) {
  return fetch(`${base}/api/routing-rules`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

await test('routing rules and per-key default models validate and persist', async () => {
  const initial = await fetch(`${base}/api/routing-rules`);
  const initialBody = await initial.json();
  assert.equal(initial.status, 200);
  assert.deepEqual(initialBody.routing, { aliases: {}, rules: [] });
  assert.ok(Array.isArray(initialBody.catalog) && initialBody.catalog.length > 0);
  assert.ok(Array.isArray(initialBody.combos));
  assert.ok(Array.isArray(initialBody.keys));

  const create = await fetch(`${base}/api/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Routing settings key', secret: 'routing_settings_secret', defaultModel: 'glm-5.3' }),
  });
  const created = await create.json();
  assert.equal(create.status, 201, JSON.stringify(created));
  assert.equal(created.key.defaultModel, 'cbcn/glm-5.3', 'the default model must store its canonical id');
  const keyId = created.key.id;
  try {
    const view = await (await fetch(`${base}/api/routing-rules`)).json();
    assert.ok(view.keys.some((key) => key.id === keyId), 'a rule may target this key id');
    assert.ok(!JSON.stringify(view).includes('routing_settings_secret'), 'the routing payload must never leak a secret');

    const bad = [
      [{ oops: true }, /Unknown routing rules field/],
      [{ aliases: [] }, /aliases must be a JSON object/],
      [{ aliases: { 'cbcn/glm-5.3': 'cbcn/glm-5.2' } }, /shadow/],
      [{ aliases: { 'chat-alias': 'cbcn/not-a-model' } }, /Invalid model/],
      [{ rules: [{ name: 'x', match: {}, models: ['cbcn/glm-5.3'] }] }, /at least one match condition/],
      [{ rules: [{ name: 'x', match: { region: 'eu' }, models: ['cbcn/glm-5.3'] }] }, /Unknown match field/],
      [{ rules: [{ name: 'x', match: { apiKeyId: 'missing-key' }, models: ['cbcn/glm-5.3'] }] }, /Unknown API key/],
      [{ rules: [{ name: 'x', match: { hasTools: true }, models: [] }] }, /needs at least one model/],
      [{ rules: [{ name: 'x', match: { hasTools: true }, models: ['cbcn/glm-5.3', 'glm-5.3'] }] }, /twice/],
      [{
        rules: [
          { name: 'dup', match: { hasTools: true }, models: ['cbcn/glm-5.3'] },
          { name: 'DUP', match: { hasTools: true }, models: ['cbcn/glm-5.3'] },
        ],
      }, /already exists/],
      [{ rules: [{ name: 'x', match: { hasTools: true }, models: ['cbcn/glm-5.3'], enabled: 'yes' }] }, /enabled must be boolean/],
      [{ rules: [{ name: 'x', match: { hasTools: true }, models: ['cbcn/glm-5.3'], extra: 1 }] }, /Unknown rule field/],
    ];
    for (const [payload, pattern] of bad) {
      const res = await patchRoutingRules(payload);
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(payload)}`);
      assert.match((await res.json()).error.message, pattern);
    }
    const unchanged = await (await fetch(`${base}/api/routing-rules`)).json();
    assert.deepEqual(unchanged.routing, { aliases: {}, rules: [] }, 'a rejected patch must not persist');

    const aliasOnly = await patchRoutingRules({ aliases: { 'chat-alias': 'glm-5.3' } });
    const aliasBody = await aliasOnly.json();
    assert.equal(aliasOnly.status, 200, JSON.stringify(aliasBody));
    assert.deepEqual(aliasBody.routing.aliases, { 'chat-alias': 'cbcn/glm-5.3' });

    const rulesSaved = await patchRoutingRules({
      rules: [{ name: 'Premium', match: { apiKeyId: keyId, hasTools: true }, models: ['glm-5.3', 'cbcn/glm-5.2'] }],
    });
    const rulesBody = await rulesSaved.json();
    assert.equal(rulesSaved.status, 200, JSON.stringify(rulesBody));
    assert.deepEqual(rulesBody.routing.aliases, { 'chat-alias': 'cbcn/glm-5.3' }, 'a rules-only patch keeps aliases');
    assert.equal(rulesBody.routing.rules.length, 1);
    assert.deepEqual(rulesBody.routing.rules[0].models, ['cbcn/glm-5.3', 'cbcn/glm-5.2'], 'rule targets are canonical');
    assert.ok(rulesBody.routing.rules[0].id, 'a saved rule gets an id');

    const draft = await patchRoutingRules({ rules: [{ name: 'Draft', enabled: false, match: { hasTools: true }, models: [] }] });
    assert.equal(draft.status, 200, 'a disabled rule may be saved without models');
    const aliasesOnly = await patchRoutingRules({ aliases: { 'chat-alias': 'glm-5.3' } });
    const aliasesBody = await aliasesOnly.json();
    assert.equal(aliasesBody.routing.rules.length, 1, 'an aliases-only patch keeps the saved rules');
    assert.equal(aliasesBody.routing.rules[0].name, 'Draft');

    const badDefault = await fetch(`${base}/api/keys/${keyId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultModel: 'cbcn/not-a-model' }),
    });
    assert.equal(badDefault.status, 400);
    assert.match((await badDefault.json()).error.message, /defaultModel/);
    const cleared = await fetch(`${base}/api/keys/${keyId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultModel: '' }),
    });
    assert.equal(cleared.status, 200);
    assert.equal((await cleared.json()).key.defaultModel, null);

    const reset = await patchRoutingRules({ aliases: {}, rules: [] });
    assert.equal(reset.status, 200);
    assert.deepEqual((await reset.json()).routing, { aliases: {}, rules: [] });
  } finally {
    await patchRoutingRules({ aliases: {}, rules: [] });
    await fetch(`${base}/api/keys/${keyId}`, { method: 'DELETE' });
  }
});

await test('routing rule matching combines conditions and skips unusable rules', async () => {
  const { estimateContextTokens, matchRoutingRule } = await import('../noroute_src/lib/routing-rules.js');
  const settings = {
    aliases: {},
    rules: [
      { id: 'off', name: 'disabled', enabled: false, match: { hasTools: true }, models: ['cbcn/glm-5.2'] },
      { id: 'key', name: 'key rule', enabled: true, match: { apiKeyId: 'key-1' }, models: ['cbcn/glm-5.2'] },
      { id: 'big', name: 'big tool turn', enabled: true, match: { hasTools: true, minContextTokens: 1000 }, models: ['glm-5.3'] },
      { id: 'header', name: 'header rule', enabled: true, match: { header: { name: 'x-route-tier', value: 'premium' } }, models: ['cbcn/glm-5.2'] },
      { id: 'stale', name: 'stale target', enabled: true, match: { hasTools: false }, models: ['cbcn/model-that-vanished'] },
      { id: 'fallback', name: 'fallback target', enabled: true, match: { hasTools: false }, models: ['cbcn/glm-5.2'] },
    ],
  };
  const small = { model: 'cbcn/glm-5.3', messages: [{ role: 'user', content: 'hi' }] };
  const toolTurn = { messages: [{ role: 'user', content: 'x'.repeat(4000) }], tools: [{ type: 'function', function: { name: 'read_file' } }] };
  const plainReq = { headers: {} };

  assert.equal(estimateContextTokens(small), 1);
  assert.equal(estimateContextTokens({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    }],
  }), 1001, 'an image adds a flat allowance');
  assert.ok(estimateContextTokens(toolTurn) >= 1000, 'the tool turn counts as a large context');

  assert.equal(matchRoutingRule(settings, small, { headers: { 'x-route-tier': 'Premium' } }, { managedId: 'key-1' }).name, 'key rule', 'the first enabled match wins');
  const bigMatch = matchRoutingRule(settings, toolTurn, plainReq, { managedId: 'key-2' });
  assert.equal(bigMatch.name, 'big tool turn');
  assert.deepEqual(bigMatch.chain, ['cbcn/glm-5.3'], 'stored rule targets are canonical at match time');
  assert.equal(matchRoutingRule(settings, small, { headers: { 'x-route-tier': 'PREMIUM' } }, { managedId: 'key-2' }).name, 'header rule', 'header matching is case-insensitive');
  const stale = matchRoutingRule(settings, small, plainReq, { managedId: 'key-2' });
  assert.equal(stale.name, 'fallback target', 'a rule whose only target vanished is skipped');
  assert.deepEqual(stale.chain, ['cbcn/glm-5.2']);
  assert.equal(matchRoutingRule({ rules: settings.rules.slice(0, 5) }, small, plainReq, { managedId: 'key-2' }), null, 'no usable rule means no rewrite');
});

await test('a saved alias rewrites the model and the request log names the alias', async () => {
  await resetCodebuddyAccounts(['routing-alias-token']);
  let comboId = null;
  try {
    const saved = await patchRoutingRules({ aliases: { 'chat-alias': 'glm-5.3' } });
    const savedBody = await saved.json();
    assert.equal(saved.status, 200, JSON.stringify(savedBody));
    assert.deepEqual(savedBody.routing.aliases, { 'chat-alias': 'cbcn/glm-5.3' });

    stubCalls.length = 0;
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'chat-alias', messages: [{ role: 'user', content: 'halo' }] }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.match(body.choices[0].message.content, /stub reply for glm-5\.3/);
    assert.deepEqual(stubCalls, ['glm-5.3'], 'the upstream must see the alias target');
    assert.equal(chatBodies.at(-1).model, 'glm-5.3');

    let log = (await (await fetch(`${base}/api/request-log`)).json()).requests.at(-1);
    assert.equal(log.requested, 'chat-alias');
    assert.equal(log.route, 'alias');
    assert.equal(log.via, 'chat-alias');
    assert.equal(log.model, 'glm-5.3');
    assert.deepEqual(log.attempted, ['cbcn/glm-5.3']);

    // An alias may point at a whole combo; the alias stays the stated reason.
    const create = await fetch(`${base}/api/combos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'alias-combo', models: ['cbcn/glm-5.3'] }),
    });
    const comboBody = await create.json();
    assert.equal(create.status, 201, JSON.stringify(comboBody));
    comboId = comboBody.combo.id;
    const savedCombo = await patchRoutingRules({ aliases: { 'alias-to-combo': 'alias-combo' } });
    const savedComboBody = await savedCombo.json();
    assert.equal(savedCombo.status, 200, JSON.stringify(savedComboBody));

    stubCalls.length = 0;
    const comboRes = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'alias-to-combo', messages: [{ role: 'user', content: 'halo' }] }),
    });
    const comboReply = await comboRes.json();
    assert.equal(comboRes.status, 200, JSON.stringify(comboReply));
    assert.match(comboReply.choices[0].message.content, /stub reply for glm-5\.3/);
    log = (await (await fetch(`${base}/api/request-log`)).json()).requests.at(-1);
    assert.equal(log.route, 'alias');
    assert.equal(log.via, 'alias-to-combo');
    assert.equal(log.model, 'glm-5.3');
    assert.deepEqual(log.attempted, ['cbcn/glm-5.3']);

    const shadow = await patchRoutingRules({ aliases: { 'cbcn/glm-5.3': 'cbcn/glm-5.2' } });
    assert.equal(shadow.status, 400);
    assert.match((await shadow.json()).error.message, /shadow/);
  } finally {
    await patchRoutingRules({ aliases: {}, rules: [] });
    if (comboId) await fetch(`${base}/api/combos/${encodeURIComponent(comboId)}`, { method: 'DELETE' });
  }
});

await test('a header routing rule walks its chain and reports the rule in the trace', async () => {
  await resetCodebuddyAccounts(['routing-rule-token-a', 'routing-rule-token-b']);
  try {
    const model = await fetch(`${base}/api/providers/codebuddy-cn/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'combo-always-429' }),
    });
    assert.ok([201, 409].includes(model.status), `catalog model: ${model.status}`);

    const saved = await patchRoutingRules({
      aliases: {},
      rules: [{
        name: 'Premium tier',
        match: { header: { name: 'x-route-tier', value: 'premium' } },
        models: ['cbcn/combo-always-429', 'glm-5.3'],
      }],
    });
    const savedBody = await saved.json();
    assert.equal(saved.status, 200, JSON.stringify(savedBody));

    stubCalls.length = 0;
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-route-tier': 'Premium' },
      body: JSON.stringify({ model: 'cbcn/glm-5.2', messages: [{ role: 'user', content: 'halo' }] }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.match(body.choices[0].message.content, /stub reply for glm-5\.3/);
    assert.deepEqual(stubCalls, ['combo-always-429', 'glm-5.3'], 'the rule chain is walked in order');

    let log = (await (await fetch(`${base}/api/request-log`)).json()).requests.at(-1);
    assert.equal(log.requested, 'cbcn/glm-5.2');
    assert.equal(log.route, 'rule');
    assert.equal(log.via, 'Premium tier');
    assert.equal(log.model, 'glm-5.3');
    assert.deepEqual(log.attempted, ['cbcn/combo-always-429', 'cbcn/glm-5.3']);

    // Without the header the router leaves the requested model alone.
    stubCalls.length = 0;
    const direct = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'cbcn/glm-5.2', messages: [{ role: 'user', content: 'halo' }] }),
    });
    const directBody = await direct.json();
    assert.equal(direct.status, 200, JSON.stringify(directBody));
    assert.match(directBody.choices[0].message.content, /stub reply for glm-5\.2/);
    assert.deepEqual(stubCalls, ['glm-5.2']);
    log = (await (await fetch(`${base}/api/request-log`)).json()).requests.at(-1);
    assert.equal(log.route, 'direct');
    assert.equal(log.via, null);
    assert.deepEqual(log.attempted, ['cbcn/glm-5.2']);
  } finally {
    await patchRoutingRules({ aliases: {}, rules: [] });
  }
});

await test('a managed key default model fills only a missing model', async () => {
  await resetCodebuddyAccounts(['routing-default-token']);
  const create = await fetch(`${base}/api/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Default model key', secret: 'routing_default_key', defaultModel: 'glm-5.3' }),
  });
  const created = await create.json();
  assert.equal(create.status, 201, JSON.stringify(created));
  assert.equal(created.key.defaultModel, 'cbcn/glm-5.3');
  const keyId = created.key.id;

  const invalid = await fetch(`${base}/api/keys/${keyId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaultModel: 'cbcn/not-a-model' }),
  });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error.message, /defaultModel/);

  const enabled = await fetch(`${base}/api/auth-settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requireApiKey: true }),
  });
  assert.equal(enabled.status, 200);
  try {
    stubCalls.length = 0;
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer routing_default_key' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'halo' }] }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.match(body.choices[0].message.content, /stub reply for glm-5\.3/);
    assert.deepEqual(stubCalls, ['glm-5.3'], 'the key default must pick the model');

    const log = (await (await fetch(`${base}/api/request-log`)).json()).requests.at(-1);
    assert.equal(log.requested, null, 'no model was requested');
    assert.equal(log.route, 'direct');
    assert.equal(log.model, 'glm-5.3');

    // An explicit model always wins over the key default.
    stubCalls.length = 0;
    const explicit = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer routing_default_key' },
      body: JSON.stringify({ model: 'cbcn/glm-5.2', messages: [{ role: 'user', content: 'halo' }] }),
    });
    const explicitBody = await explicit.json();
    assert.equal(explicit.status, 200, JSON.stringify(explicitBody));
    assert.match(explicitBody.choices[0].message.content, /stub reply for glm-5\.2/);
    assert.deepEqual(stubCalls, ['glm-5.2']);
    const explicitLog = (await (await fetch(`${base}/api/request-log`)).json()).requests.at(-1);
    assert.equal(explicitLog.requested, 'cbcn/glm-5.2');
    assert.equal(explicitLog.model, 'glm-5.2');
  } finally {
    await fetch(`${base}/api/auth-settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requireApiKey: false }),
    });
    await fetch(`${base}/api/keys/${keyId}`, { method: 'DELETE' });
  }
});

function patchBudgets(payload) {
  return fetch(`${base}/api/budgets`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

await test('daily budgets validate, persist and report today usage', async () => {
  const initial = await (await fetch(`${base}/api/budgets`)).json();
  assert.equal(initial.enabled, true);
  assert.match(initial.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Array.isArray(initial.keys));
  const codebuddy = initial.providers.find((row) => row.id === 'codebuddy-cn');
  assert.ok(codebuddy, 'every provider is listed with its limit and usage');
  assert.equal(codebuddy.limit, null);

  const create = await fetch(`${base}/api/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Budget settings key', secret: 'budget_settings_secret' }),
  });
  const created = await create.json();
  assert.equal(create.status, 201, JSON.stringify(created));
  const keyId = created.key.id;
  try {
    const bad = [
      [{}, /Nothing to update/],
      [{ enabled: 'yes' }, /enabled must be boolean/],
      [{ oops: true }, /Unknown field/],
      [{ keys: [] }, /keys must be a JSON object/],
      [{ keys: { [keyId]: {} } }, /needs at least one of tokens or cost/],
      [{ keys: { [keyId]: { tokens: 0 } } }, /tokens must be a positive integer/],
      [{ keys: { [keyId]: { cost: -1 } } }, /cost must be a positive number/],
      [{ keys: { [keyId]: { extra: 1 } } }, /Unknown limit field/],
      [{ providers: { '': { tokens: 10 } } }, /needs an id/],
    ];
    for (const [payload, pattern] of bad) {
      const res = await patchBudgets(payload);
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(payload)}`);
      assert.match((await res.json()).error.message, pattern);
    }
    const unchanged = await (await fetch(`${base}/api/budgets`)).json();
    assert.equal(unchanged.keys.find((row) => row.id === keyId).limit, null, 'a rejected patch must not persist');

    const saved = await patchBudgets({ keys: { [keyId]: { tokens: 1000, cost: 0.5 } } });
    const savedBody = await saved.json();
    assert.equal(saved.status, 200, JSON.stringify(savedBody));
    const row = savedBody.keys.find((entry) => entry.id === keyId);
    assert.deepEqual(row.limit, { tokens: 1000, cost: 0.5 });
    assert.equal(row.used.tokens, 0);
    assert.equal(row.percent, 0);
    assert.equal(row.costPercent, 0);
    assert.ok(!JSON.stringify(savedBody).includes('budget_settings_secret'), 'the payload must never leak a key secret');

    const providerSaved = await patchBudgets({ providers: { 'codebuddy-cn': { tokens: 5000 } } });
    const providerBody = await providerSaved.json();
    assert.equal(providerSaved.status, 200, JSON.stringify(providerBody));
    assert.deepEqual(providerBody.providers.find((entry) => entry.id === 'codebuddy-cn').limit, { tokens: 5000 });
    assert.deepEqual(
      providerBody.keys.find((entry) => entry.id === keyId).limit,
      { tokens: 1000, cost: 0.5 },
      'a provider patch keeps key limits',
    );

    // The page must still show a configured limit while enforcement is off.
    const disabled = await patchBudgets({ enabled: false });
    const disabledBody = await disabled.json();
    assert.equal(disabled.status, 200);
    assert.equal(disabledBody.enabled, false);
    assert.deepEqual(disabledBody.keys.find((entry) => entry.id === keyId).limit, { tokens: 1000, cost: 0.5 });

    const cleared = await patchBudgets({ enabled: true, keys: { [keyId]: null }, providers: { 'codebuddy-cn': null } });
    const clearedBody = await cleared.json();
    assert.equal(cleared.status, 200);
    assert.equal(clearedBody.enabled, true);
    assert.equal(clearedBody.keys.find((entry) => entry.id === keyId).limit, null);
    assert.equal(clearedBody.providers.find((entry) => entry.id === 'codebuddy-cn').limit, null);
  } finally {
    await patchBudgets({ enabled: true, keys: { [keyId]: null }, providers: { 'codebuddy-cn': null } });
    await fetch(`${base}/api/keys/${keyId}`, { method: 'DELETE' });
  }
});

await test('a key budget refuses the request before upstream and alerts once', async () => {
  const http = await import('node:http');
  await resetCodebuddyAccounts(['budget-key-token']);
  const delivered = [];
  const receiver = http.createServer((req, res) => {
    let text = '';
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => {
      try { delivered.push(JSON.parse(text)); } catch { /* a malformed hook is not the router's problem */ }
      res.writeHead(204).end();
    });
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const hookUrl = `http://127.0.0.1:${receiver.address().port}/hook`;

  const create = await fetch(`${base}/api/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Budget key', secret: 'budget_key_secret' }),
  });
  const created = await create.json();
  assert.equal(create.status, 201, JSON.stringify(created));
  const keyId = created.key.id;
  const ask = () => fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer budget_key_secret' },
    body: JSON.stringify({ model: 'cbcn/glm-5.3', messages: [{ role: 'user', content: 'halo' }] }),
  });
  try {
    const hook = await fetch(`${base}/api/webhook`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, url: hookUrl }),
    });
    assert.equal(hook.status, 200, JSON.stringify(await hook.json()));

    // The limit must exist before the first request: counters are only written
    // for scopes that are capped at the time the request completes.
    assert.equal((await patchBudgets({ keys: { [keyId]: { tokens: 100000 } } })).status, 200);
    const auth = await fetch(`${base}/api/auth-settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requireApiKey: true }),
    });
    assert.equal(auth.status, 200);

    stubCalls.length = 0;
    const first = await ask();
    const firstBody = await first.json();
    assert.equal(first.status, 200, JSON.stringify(firstBody));
    assert.deepEqual(stubCalls, ['glm-5.3']);
    const afterFirst = await (await fetch(`${base}/api/budgets`)).json();
    const row = afterFirst.keys.find((entry) => entry.id === keyId);
    assert.ok(row.used.tokens > 0, 'a successful request must be counted');
    assert.equal(row.limit.tokens, 100000);

    assert.equal((await patchBudgets({ keys: { [keyId]: { tokens: 1 } } })).status, 200);
    stubCalls.length = 0;
    const blocked = await ask();
    const blockedBody = await blocked.json();
    assert.equal(blocked.status, 429, JSON.stringify(blockedBody));
    assert.equal(blockedBody.error.type, 'budget_error');
    assert.equal(blockedBody.error.code, 'budget_exhausted');
    assert.equal(blockedBody.error.scope, `key:${keyId}`);
    assert.deepEqual(blockedBody.error.reasons, ['tokens']);
    assert.equal(blockedBody.error.limit.tokens, 1);
    assert.ok(blockedBody.error.used.tokens > 0);
    assert.match(blockedBody.error.message, /Daily budget reached/);
    assert.equal(stubCalls.length, 0, 'a budget refusal must never reach upstream');
    const log = (await (await fetch(`${base}/api/request-log`)).json()).requests.at(-1);
    assert.equal(log.status, 429);

    assert.ok(await waitFor(() => delivered.some((event) => event.event === 'budget')), 'a budget alert must reach the webhook');
    const alerts = delivered.filter((event) => event.event === 'budget');
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].scope, `key:${keyId}`);
    assert.deepEqual(alerts[0].reasons, ['tokens']);
    assert.ok(!JSON.stringify(alerts[0]).includes('budget_key_secret'), 'alerts carry metadata only');

    const again = await ask();
    assert.equal(again.status, 429);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(delivered.filter((event) => event.event === 'budget').length, 1, 'one alert per scope per day');
  } finally {
    await fetch(`${base}/api/auth-settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requireApiKey: false }),
    });
    await fetch(`${base}/api/webhook`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false, url: '' }),
    });
    await patchBudgets({ keys: { [keyId]: null } });
    await fetch(`${base}/api/keys/${keyId}`, { method: 'DELETE' });
    await resetCodebuddyAccounts([]);
    await new Promise((resolve) => receiver.close(resolve));
  }
});

await test('a provider budget falls back inside a chain', async () => {
  await resetCodebuddyAccounts(['budget-provider-token']);
  let providerId = null;
  let fallbackCombo = null;
  let blockedCombo = null;
  try {
    const providerRes = await fetch(`${base}/api/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'budget-alt',
        name: 'Budget Alt',
        baseUrl: stubBase,
        chatPath: '/chat/completions',
        models: ['alt-model'],
        // The stub rejects unauthenticated chat calls, so the fallback target
        // needs a real pool account like any other credentialed provider.
        requiresAccount: true,
      }),
    });
    const providerBody = await providerRes.json();
    assert.equal(providerRes.status, 201, JSON.stringify(providerBody));
    providerId = providerBody.created;
    const altAccount = await fetch(`${base}/api/providers/${providerId}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Budget Alt account', access_token: 'budget-alt-token' }),
    });
    assert.equal(altAccount.status, 201, await altAccount.text());

    assert.equal((await patchBudgets({ providers: { 'codebuddy-cn': { tokens: 100000 } } })).status, 200);
    stubCalls.length = 0;
    const warm = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'cbcn/glm-5.3', messages: [{ role: 'user', content: 'halo' }] }),
    });
    assert.equal(warm.status, 200, JSON.stringify(await warm.json()));
    assert.deepEqual(stubCalls, ['glm-5.3']);
    const budgetView = await (await fetch(`${base}/api/budgets`)).json();
    const providerRow = budgetView.providers.find((entry) => entry.id === 'codebuddy-cn');
    assert.ok(providerRow.used.tokens > 0, 'provider usage is counted for a capped provider');
    assert.equal((await patchBudgets({ providers: { 'codebuddy-cn': { tokens: 1 } } })).status, 200);

    const createFallback = await fetch(`${base}/api/combos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'budget-fallback', models: ['cbcn/glm-5.3', 'budget-alt/alt-model'] }),
    });
    const fallbackBody = await createFallback.json();
    assert.equal(createFallback.status, 201, JSON.stringify(fallbackBody));
    fallbackCombo = fallbackBody.combo.id;

    stubCalls.length = 0;
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'budget-fallback', messages: [{ role: 'user', content: 'halo' }] }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.match(body.choices[0].message.content, /stub reply for alt-model/);
    assert.deepEqual(stubCalls, ['alt-model'], 'the capped provider must not be called');
    const log = (await (await fetch(`${base}/api/request-log`)).json()).requests.at(-1);
    assert.deepEqual(log.attempted, ['cbcn/glm-5.3', 'budget-alt/alt-model'], 'the trace keeps the skipped attempt');

    const createBlocked = await fetch(`${base}/api/combos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'budget-blocked', models: ['cbcn/glm-5.3', 'cbcn/glm-5.2'] }),
    });
    const blockedBody = await createBlocked.json();
    assert.equal(createBlocked.status, 201, JSON.stringify(blockedBody));
    blockedCombo = blockedBody.combo.id;

    stubCalls.length = 0;
    const allBlocked = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'budget-blocked', messages: [{ role: 'user', content: 'halo' }] }),
    });
    const allBlockedBody = await allBlocked.json();
    assert.equal(allBlocked.status, 429, JSON.stringify(allBlockedBody));
    assert.match(allBlockedBody.error.message, /Tried: cbcn\/glm-5\.3 → cbcn\/glm-5\.2/);
    assert.deepEqual(allBlockedBody.error.attempted, ['cbcn/glm-5.3', 'cbcn/glm-5.2']);
    assert.equal(stubCalls.length, 0);
  } finally {
    await patchBudgets({ providers: { 'codebuddy-cn': null } });
    if (fallbackCombo) await fetch(`${base}/api/combos/${encodeURIComponent(fallbackCombo)}`, { method: 'DELETE' });
    if (blockedCombo) await fetch(`${base}/api/combos/${encodeURIComponent(blockedCombo)}`, { method: 'DELETE' });
    if (providerId) await fetch(`${base}/api/providers/${encodeURIComponent(providerId)}`, { method: 'DELETE' });
    await resetCodebuddyAccounts([]);
  }
});

await test('maintenance settings validate and a manual run records its result', async () => {
  const initial = await (await fetch(`${base}/api/maintenance`)).json();
  assert.equal(initial.settings.enabled, true);
  assert.equal(initial.settings.intervalMinutes, 15);
  assert.equal(initial.running, false, 'the scheduler starts only from the server entry point');
  assert.deepEqual(initial.tasks.map((task) => task.id), ['tokens', 'quota', 'catalog']);
  assert.ok(initial.tasks.every((task) => task.due === true && task.lastRunAt === null));

  const bad = [
    [{}, /Nothing to update/],
    [{ enabled: 'yes' }, /enabled must be boolean/],
    [{ intervalMinutes: 4 }, /between 5 and 1440/],
    [{ intervalMinutes: 1441 }, /between 5 and 1440/],
    [{ intervalMinutes: 15.5 }, /between 5 and 1440/],
    [{ oops: 1 }, /Unknown field/],
  ];
  for (const [payload, pattern] of bad) {
    const res = await fetch(`${base}/api/maintenance`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(payload)}`);
    assert.match((await res.json()).error.message, pattern);
  }

  const saved = await fetch(`${base}/api/maintenance`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ intervalMinutes: 30 }),
  });
  const savedBody = await saved.json();
  assert.equal(saved.status, 200, JSON.stringify(savedBody));
  assert.equal(savedBody.settings.intervalMinutes, 30);
  assert.equal(savedBody.tasks[0].everyMinutes, 10, 'the task cadence is fixed; the interval only decides how often to check');

  const disabled = await fetch(`${base}/api/maintenance`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal((await disabled.json()).settings.enabled, false);
  const reenabled = await fetch(`${base}/api/maintenance`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal((await reenabled.json()).settings.intervalMinutes, 30, 'a partial patch keeps the interval');

  const unknown = await fetch(`${base}/api/maintenance/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tasks: ['nope'] }),
  });
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json()).error.message, /Unknown maintenance task/);

  const run = await fetch(`${base}/api/maintenance/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tasks: ['tokens'] }),
  });
  const runBody = await run.json();
  assert.equal(run.status, 200, JSON.stringify(runBody));
  assert.equal(runBody.results.length, 1);
  assert.equal(runBody.results[0].id, 'tokens');
  assert.equal(runBody.results[0].ok, true);
  assert.equal(runBody.snapshot.running, false);
  const tokensTask = runBody.snapshot.tasks.find((task) => task.id === 'tokens');
  assert.ok(tokensTask.lastRunAt > 0, 'a manual run records its time');
  assert.equal(tokensTask.due, false, 'a just-run task is no longer due');
  assert.ok(tokensTask.lastResult.summary.length > 0);

  const reset = await fetch(`${base}/api/maintenance`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true, intervalMinutes: 15 }),
  });
  assert.equal(reset.status, 200);
});

server.close();
stub.close();
closeDb();
for (const suffix of ['', '-wal', '-shm']) {
  rmSync(`${DB_FILE}${suffix}`, { force: true });
}

for (const [status, name, detail] of results) {
  console.log(`${status} ${name}${detail ? ` - ${detail}` : ''}`);
}
const failed = results.filter(([status]) => status === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
