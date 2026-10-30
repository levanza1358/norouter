import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Keep the test hermetic: a throwaway database, and no real credential. The
// chat path must fail before it ever reaches the network.
const TEST_DB_FILE = join(tmpdir(), `norouter-smoke-${process.pid}.db`);
process.env.NOROUTER_DB = TEST_DB_FILE;
delete process.env.CODEBUDDY_CN_TOKEN;
delete process.env.CODEBUDDY_CN_API_KEY;

const { createStubServer, calls: stubCalls, chatBodies, probeShapes } = await import('./stub-upstream.js');

const stub = createStubServer();
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const stubBase = `http://127.0.0.1:${stub.address().port}`;

// Point the shipped provider at the stub for chat, refresh and quota.
process.env.CODEBUDDY_CN_BASE_URL = `${stubBase}/v2`;
process.env.CODEBUDDY_CN_REFRESH_URL = `${stubBase}/v2/plugin/auth/token/refresh`;
process.env.CODEBUDDY_CN_QUOTA_URL = `${stubBase}/v2/billing/meter/get-user-resource`;
process.env.CODEBUDDY_CN_CHECKIN_URL = `${stubBase}/v2/billing/meter/daily-checkin`;

const { resolveModel } = await import('../src/lib/model.js');
const { providers } = await import('../src/providers/index.js');
const { createAccumulator, readSSEEvents } = await import('../src/lib/sse.js');
const { parseCodebuddyQuota } = await import('../src/lib/codebuddy.js');
const { applyReplyFilters, buildInstruction } = await import('../src/lib/reply-filters.js');
const { toResponsesRequest } = await import('../src/lib/responses-format.js');
const {
  bulkCreateAccounts,
  createAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  pickAccount,
  markFailure,
  previewAccounts,
} = await import('../src/lib/accounts.js');
// The database module resolves NOROUTER_DB at import time; assert it stayed
// hermetic so the new usage table never touches the operator's real history.
  const { closeDb, DB_FILE, getDb } = await import('../src/lib/db.js');

assert.equal(DB_FILE, TEST_DB_FILE, 'smoke tests must use the throwaway database');
const { createServer } = await import('../src/server.js');
const { SESSION_TTL_MS } = await import('../src/lib/dashboard-session.js');
const { validPort } = await import('../src/lib/local-config.js');
const { autostartPlatform, autostartSupported, autostartPlan } = await import('../src/lib/autostart.js');
const { updateNeedsStash } = await import('../src/lib/git-update.js');

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

await test('norouter CLI exposes start, dev, test and version', () => {
  const cli = join(import.meta.dirname, '..', 'bin', 'norouter.js');
  const help = execFileSync(process.execPath, [cli, 'help'], { encoding: 'utf8' });
  for (const command of ['start', 'restart', 'stop', 'update', 'dev', 'test', 'install', 'autostart-on', 'autostart-off', 'autostart-status', 'uninstall']) {
    assert.match(help, new RegExp(`^\\s+${command}\\b`, 'm'), `${command} must be listed`);
  }
  const version = execFileSync(process.execPath, [cli, 'version'], { encoding: 'utf8' }).trim();
  assert.match(version, /^\d+\.\d+\.\d+/);
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

await test('in-stream error frame is captured, not swallowed', async () => {
  const sse = 'data: {"error":{"message":"quota exhausted","type":"rate_limit"}}\n\n';
  const acc = createAccumulator();
  for await (const event of readSSEEvents(streamFrom(sse))) acc.feed(event.data);
  assert.equal(acc.state.error.message, 'quota exhausted');
});

const { server } = createServer({ port: 0, host: '127.0.0.1', logRequests: false });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

await test('autostart planner stays platform-local and secret-free', () => {
  const plan = autostartPlan();
  assert.equal(plan.platform, autostartPlatform());
  assert.equal(plan.supported, autostartSupported());
  assert.ok(!JSON.stringify(plan).includes('ROUTER_API_KEY'));
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
  assert.equal((await import('../src/lib/local-config.js')).validHost('0.0.0.0'), '0.0.0.0');
  assert.equal((await import('../src/lib/local-config.js')).validHost(''), null);
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
  const { compressToolOutput, applyRtk } = await import('../src/lib/rtk.js');
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
  const noop = { language: 'auto', verbosity: 'balanced', coding: false };
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

  // Endpoint: defaults, valid patch, invalid patches.
  const defaults = await (await fetch(`${base}/api/reply-filters`)).json();
  assert.deepEqual(defaults, { language: 'auto', verbosity: 'balanced', coding: false });
  const patched = await fetch(`${base}/api/reply-filters`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ language: 'id', verbosity: 'concise', coding: true }),
  });
  assert.equal(patched.status, 200);
  assert.deepEqual(await patched.json(), { language: 'id', verbosity: 'concise', coding: true });
  assert.deepEqual(await (await fetch(`${base}/api/reply-filters`)).json(), { language: 'id', verbosity: 'concise', coding: true });

  for (const bad of [
    { language: 'xx' },
    { verbosity: 'loud' },
    { coding: 'yes' },
    { language: 'id', extra: true },
  ]) {
    const res = await fetch(`${base}/api/reply-filters`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bad) });
    assert.equal(res.status, 400, JSON.stringify(bad));
  }

  // Reset to defaults so later chat-path assertions start clean.
  await fetch(`${base}/api/reply-filters`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ language: 'auto', verbosity: 'balanced', coding: false }) });
});

await test('reply style instructions reach the upstream and no-op leaves the body alone', async () => {
  const created = await fetch(`${base}/api/providers/codebuddy-cn/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Reply style account', access_token: 'reply-style-token' }),
  });
  assert.equal(created.status, 201);
  try {
    // language='id' must inject the Bahasa Indonesia instruction.
    await fetch(`${base}/api/reply-filters`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ language: 'id', verbosity: 'balanced', coding: false }) });
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

    // Idempotency across the wire: replaying the returned history must not stack.
    chatBodies.length = 0;
    const replay = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'cbcn/glm-5.3', messages: idUpstream.messages }),
    });
    assert.equal(replay.status, 200);
    const replaySystem = chatBodies.find((item) => item.model === 'glm-5.3')?.messages.find((message) => message.role === 'system');
    assert.equal((replaySystem.content.match(/\[norouter reply style\]/g) || []).length, 1, 'replayed history must not duplicate the instruction');

    // All no-op: the upstream body must equal the client body exactly.
    await fetch(`${base}/api/reply-filters`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ language: 'none', verbosity: 'balanced', coding: false }) });
    chatBodies.length = 0;
    const plain = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'cbcn/glm-5.3', messages: [{ role: 'user', content: 'plain' }] }),
    });
    assert.equal(plain.status, 200);
    const plainUpstream = chatBodies.find((item) => item.model === 'glm-5.3');
    assert.deepEqual(plainUpstream.messages, [{ role: 'user', content: 'plain' }], 'no-op filters must not alter the message list');
  } finally {
    await fetch(`${base}/api/reply-filters`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ language: 'auto', verbosity: 'balanced', coding: false }) });
    const account = (await (await fetch(`${base}/api/providers/codebuddy-cn/accounts?pageSize=200`)).json()).items
      .find((item) => item.label === 'Reply style account');
    if (account) await fetch(`${base}/api/providers/codebuddy-cn/accounts/${account.id}`, { method: 'DELETE' });
  }
});

await test('reply style instruction survives the Responses translation', async () => {
  const settings = { language: 'en', verbosity: 'detailed', coding: true };
  const body = applyReplyFilters({ model: 'cx/gpt-5.3-codex', messages: [{ role: 'user', content: 'hi' }] }, settings);
  const responses = toResponsesRequest(body);
  const system = responses.input.find((item) => item.role === 'system');
  assert.ok(system, 'responses input must carry the injected system message');
  assert.match(system.content, /Reply in English\./);
  assert.match(system.content, /Explain thoroughly/);
  assert.match(system.content, /Prefer short, minimal code/);
  assert.equal((system.content.match(/\[norouter reply style\]/g) || []).length, 3, 'three instructions share three markers');
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
  assert.equal((await fetch(`${base}/assets/app.js`, { headers: { cookie: '' } })).status, 200);
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
  const dashboardJs = await (await fetch(`${base}/assets/app.js`)).text();
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
  const chatJs = await (await fetch(`${base}/assets/app.js`)).text();
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
  const { modelPricing, estimateCost } = await import('../src/lib/pricing.js');
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
  const { recordRequestLog, requestLogs, redact } = await import('../src/lib/request-log.js');
  const before = requestLogs().length;
  recordRequestLog({
    provider: 'codebuddy-cn',
    model: 'glm-5.3',
    account: 'Account 1',
    tokensIn: 12,
    tokensOut: 3,
    ms: 40,
    status: 200,
  });
  recordRequestLog({ provider: 'codebuddy-cn', model: 'x', status: 502, error: 'Bearer abc123 failed' });
  const logs = requestLogs();
  assert.equal(logs.length, before + 2);
  assert.equal(logs[logs.length - 1].status, 502);
  assert.doesNotMatch(logs[logs.length - 1].error, /abc123/, 'tokens must be redacted');
  assert.match(logs[logs.length - 1].error, /\[redacted\]/);

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
  assert.match(html, /id="replyFiltersNote"[^>]*role="status"/);
  assert.match(html, /id="tokenSaverPonytail"[^>]*type="checkbox"/);
  assert.match(html, /id="tokenSaverRtk"[^>]*type="checkbox"/);
  assert.match(html, /id="tokenSaverCaveman"[^>]*type="checkbox"/);
  assert.match(html, /id="tokenSaverNote"[^>]*role="status"/);
  assert.match(html, /id="webhookToggle"[^>]*type="checkbox"/);
  assert.match(html, /id="webhookUrl"[^>]*type="url"/);
  assert.match(html, /id="requestLogTable"/);
  const js = await (await fetch(`${base}/assets/app.js`)).text();
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
  assert.deepEqual(rail, ['/', '/chat', '/providers', '/usage', '/api-keys', '/combos', '/settings']);
  assert.equal((html.match(/id="requireKeyToggle"/g) || []).length, 1);
  assert.match(html, /id="pageTitle">Dashboard<\/h1>/);

  const providers = await (await fetch(`${base}/providers`)).text();
  assert.match(providers, /class="page-intro">Manage upstream endpoints, accounts, and available models\.<\/p>/);

  const js = await (await fetch(`${base}/assets/app.js`)).text();
  assert.match(js, /const provider = detail\.provider \|\| \{\};/);
  assert.match(js, /escapeHtml\(value\)/);
});

await test('dashboard omits duplicate providers and health cards while Settings keeps status', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.doesNotMatch(html, /<article class="card[^>]*>\s*[\s\S]*?Providers[\s\S]*?id="providerList"/);
  assert.doesNotMatch(html, /id="providerList"|id="providerHint"|id="healthStatus"|id="healthUptime"|id="healthPort"|id="healthKey"|id="healthChip"/);
  assert.doesNotMatch(html, /<h2 class="card-title">Health<\/h2>/);
  assert.match(html, /id="sStatus"/);
  assert.match(html, /id="sUptime"/);
  assert.match(html, /id="sPort"/);

  const js = await (await fetch(`${base}/assets/app.js`)).text();
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
  assert.match(html, /src="\/assets\/app\.js"/);
  assert.match(html, /<section class="page" data-page="\/" hidden>/, 'dashboard must not paint before the initial route');
  assert.match(html, /<div class="splash" id="appSplash"[^>]*>/);
  assert.match(html, /dashboard-booting/);
  assert.match(html, /html\.dashboard-booting \{ overflow: hidden; \}/);

  const css = await fetch(`${base}/assets/styles.css`);
  assert.equal(css.status, 200, 'styles asset must be served');
  assert.match(css.headers.get('content-type') || '', /text\/css/);

  const js = await fetch(`${base}/assets/app.js`);
  assert.equal(js.status, 200, 'dashboard script must be served');
  assert.match(js.headers.get('content-type') || '', /javascript/);
});

await test('every dashboard select uses the custom dropdown', async () => {
  const html = await (await fetch(`${base}/`)).text();
  const selects = [...html.matchAll(/<select\b[^>]*>/g)].map((m) => m[0]);
  assert.ok(selects.length >= 5, 'expected the dashboard selects to still be present');
  const native = selects.filter((tag) => !/data-custom-select/.test(tag));
  assert.deepEqual(native, [], 'no select may render with native chrome');

  const js = await (await fetch(`${base}/assets/app.js`)).text();
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
  const js = await (await fetch(`${base}/assets/app.js`)).text();
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
  assert.match(html, /id="dashboardHistorySource"[^>]*>History<\/span>/);
  assert.doesNotMatch(html, /Persisted usage from SQLite|Persisted requests from SQLite/);
  const js = await (await fetch(`${base}/assets/app.js`)).text();
  assert.match(js, /renderStatistics\(latest \|\| \{\}, report\)/);
  assert.match(js, /renderRequests\(latest \|\| \{\}, report\)/);
  assert.match(js, /renderModels\(latest \|\| \{\}, report\)/);
  assert.match(js, /const rows = report\?\.activity \|\| \[\]/);
  assert.match(js, /totals\.tokensIn/);
});

await test('dashboard has branded logo and pointer background polish', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /class="rail-logo"><svg[^>]*aria-label="norouter"/);
  assert.match(html, /class="splash-mark"><svg[^>]*aria-label="norouter"/);
  assert.match(html, /class="pointer-glow"/);
  assert.match(html, /dashboard-lock-drift/);
  assert.match(html, /lock-pointer-x/);
  const css = await (await fetch(`${base}/assets/styles.css`)).text();
  assert.match(css, /\.pointer-glow\s*\{/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  const js = await (await fetch(`${base}/assets/app.js`)).text();
  assert.match(js, /pointermove/);
  assert.match(js, /requestAnimationFrame\(paintPointerGlow\)/);
});

await test('dashboard keeps connection actions compact and useful', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /class="topbar-connect"[^>]*id="topbarConnect"/);
  assert.match(html, /id="copyBase"[^>]*>Copy</);
  assert.match(html, /id="copyApiKey"/);
  assert.match(html, /id="dashboardApiKey"/);
  assert.doesNotMatch(html, /<h2 class="card-title">Connect<\/h2>/);
  assert.doesNotMatch(html, /copyBase3/);
  assert.doesNotMatch(html, /SQLite/);
  const js = await (await fetch(`${base}/assets/app.js`)).text();
  assert.match(js, /function renderDashboardConnect/);
  assert.match(js, /dashboardApiKeySecret/);
  assert.match(js, /copyText\(dashboardApiKeySecret\)/);
});

await test('dashboard declares its data ranges and chart summary', async () => {
  const html = await (await fetch(`${base}/`)).text();
  // Session counters must say what window they cover; the usage page uses
  // day/week/month/all, so the dashboard cannot stay unlabelled.
  assert.match(html, /id="statRangeChip"[^>]*>since start</);
  assert.match(html, /id="reqRangeChip"[^>]*>since start</);
  assert.match(html, /id="dashboardRangeTabs"[^>]*role="tablist"/);
  assert.equal((html.match(/data-dashboard-range=/g) || []).length, 4);
  assert.match(html, /id="dashboardHistoryIn"/);
  assert.match(html, /id="dashboardHistoryRequests"/);
  assert.match(html, /id="dashboardHistoryStatsNote"[^>]*role="status"/);
  assert.match(html, /id="dashboardHistoryRequestsNote"[^>]*role="status"/);
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
  assert.match(html, /id="uChartTypes"[^>]*role="tablist"/);
  assert.equal((html.match(/data-usage-chart=/g) || []).length, 4);
  assert.equal((html.match(/role="tab"[^>]*data-usage-chart=/g) || []).length, 4);
  assert.match(html, /id="uSparkLegend"/);
  const js = await (await fetch(`${base}/assets/app.js`)).text();
  assert.match(js, /\/api\/usage\?range=/);
  assert.match(js, /data-dashboard-range/);
  assert.match(js, /const USAGE_PAGE_SIZE = 10;/);
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
  for (const path of ['/providers', '/usage', '/chat', '/settings', '/api-keys', '/dashboard', '/providers/codebuddy-cn']) {
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
    const { saveCodexAccountCatalog } = await import('../src/lib/codex-account.js');
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
    const { saveCodexAccountCatalog } = await import('../src/lib/codex-account.js');
    saveCodexAccountCatalog(cooldown.id, 'free', ['gpt-stub-luna']);
    saveCodexAccountCatalog(healthy.id, 'pro', ['gpt-stub-luna']);
    const { cooldownAccount } = await import('../src/lib/accounts.js');
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
    const { saveCodexAccountCatalog } = await import('../src/lib/codex-account.js');
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
  } finally {
    const del = await fetch(`${base}/api/providers/${id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
  }

  const gone = await fetch(`${base}/api/providers/${id}`);
  assert.equal(gone.status, 404);
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
    { name: 'No Models', baseUrl: 'http://127.0.0.1:1/v1', models: '' },
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
  assert.equal(search.total, 11, 'Account 1 plus Account 10..19');

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
  assert.deepEqual(picked, ['Account 1', 'Account 2', 'Account 3', 'Account 1']);

  for (const row of listAccounts(provider, { pageSize: 50 }).items) deleteAccount(row.id);
});

await test('sequential strategy reuses the first healthy account', () => {
  const provider = 'unit-seq';
  for (const token of ['seq-one', 'seq-two', 'seq-three']) {
    createAccount(provider, { access_token: token });
  }

  const picked = [1, 2, 3].map(() => pickAccount(provider, 'sequential')?.label);
  assert.deepEqual(picked, ['Account 1', 'Account 1', 'Account 1']);
  // An unknown strategy falls back to round-robin rather than breaking routing.
  assert.equal(pickAccount(provider, 'not-a-strategy')?.label, 'Account 1');
  assert.equal(pickAccount(provider, 'not-a-strategy')?.label, 'Account 2');

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
  assert.equal(rows.find((row) => row.label === 'Account 1').requests, 2, 'sequential must keep the first account');
  assert.equal(rows.find((row) => row.label === 'Account 2').requests, 0);

  await setStrategy('round-robin');
  // The round-robin cursor starts at the first account, so two requests touch
  // both accounts regardless of which one the previous strategy left on.
  await send();
  await send();
  rows = await pool();
  assert.equal(rows.find((row) => row.label === 'Account 1').requests, 3);
  assert.equal(rows.find((row) => row.label === 'Account 2').requests, 1, 'round-robin must move to the next account');

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
  const limited = pool.items.find((row) => row.label === 'Account 1');
  const good = pool.items.find((row) => row.label === 'Account 2');

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
  assert.equal(pool.items.find((row) => row.label === 'Account 3').requests, 1);
  assert.equal(pool.items.filter((row) => row.status === 'cooldown').length, 2);
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
  const { beginActiveRequest, endActiveRequest, activeRequestSnapshot, statusSnapshot } = await import('../src/lib/stats.js');
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
