import {
  getProxyRow,
  proxyRows,
  proxyTestJob,
  recordProxyTest,
  resetTestJob,
  updateTestJob,
} from './proxies.js';
import { proxyErrorCode, proxyFetch } from './proxy-fetch.js';

// Overridable so the suite can point probes at its local target instead of
// reaching the public internet.
export const TEST_URL = process.env.PROXY_TEST_URL?.trim() || 'https://www.gstatic.com/generate_204';
export const TEST_TIMEOUT_MS = 8_000;
const TEST_CONCURRENCY = 8;

// Any HTTP response means the tunnel worked; the target's status is reported,
// not treated as a proxy failure.
export async function testProxy(row, { timeoutMs = TEST_TIMEOUT_MS } = {}) {
  const startedAt = Date.now();
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await proxyFetch(row, TEST_URL, { method: 'GET', signal });
    try {
      await response.body?.cancel();
    } catch {
      // The probe is done; a failed body cancel changes nothing.
    }
    return { ok: true, latencyMs: Date.now() - startedAt, status: response.status, error: null };
  } catch (err) {
    const timedOut = err?.name === 'AbortError' || err?.name === 'TimeoutError' || signal.aborted;
    return {
      ok: false,
      latencyMs: null,
      status: null,
      error: timedOut ? 'timeout' : proxyErrorCode(err),
    };
  }
}

export async function testAndRecord(row, options) {
  const result = await testProxy(row, options);
  recordProxyTest(row.id, result);
  return result;
}

async function pool(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

// Shared by the manual "Test all" job and the maintenance task.
export async function runProxyTests(rows, onResult = () => {}) {
  await pool(rows, TEST_CONCURRENCY, async (row) => {
    const result = await testAndRecord(row);
    onResult(result);
  });
}

function bumpTestJob(patch) {
  const job = proxyTestJob();
  return updateTestJob({
    tested: job.tested + (patch.tested || 0),
    ok: job.ok + (patch.ok || 0),
    failed: job.failed + (patch.failed || 0),
    running: true,
  });
}

async function runTestJob(rows) {
  try {
    await runProxyTests(rows, (result) => {
      bumpTestJob(result.ok ? { tested: 1, ok: 1 } : { tested: 1, failed: 1 });
    });
  } finally {
    updateTestJob({ running: false, finishedAt: Date.now() });
  }
}

// Starts one background job. Rejects a second concurrent job with 409; the
// route layer turns that into the active snapshot.
export function startProxyTestJob(ids = null) {
  if (proxyTestJob().running) return { status: 409, testing: proxyTestJob() };
  const rows = Array.isArray(ids) && ids.length
    ? ids.map((id) => getProxyRow(id)).filter(Boolean)
    : proxyRows();
  resetTestJob();
  updateTestJob({ running: true, startedAt: Date.now() });
  void runTestJob(rows);
  return { status: 202, testing: proxyTestJob() };
}
