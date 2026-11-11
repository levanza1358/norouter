import assert from 'node:assert/strict';
import { parseCodexUsage } from '../src/lib/codex-usage.js';

const parsed = parseCodexUsage({
  plan_type: 'plus',
  rate_limits_by_limit_id: {
    codex: {
      session: { used_percent: 25, reset_at: 1_800_000_000 },
      weekly: { percent_used: 50, resetAt: '2026-11-02T00:00:00Z' },
    },
    review: { session: { used_percent: 10, reset_at: 1_800_000_000 } },
    spark: { session: { used_percent: 75, reset_at: 1_800_000_000 } },
  },
});
assert.equal(parsed.plan, 'plus');
assert.equal(parsed.quotas.session.used, 25);
assert.equal(parsed.quotas.session.remaining, 75);
assert.equal(parsed.quotas.weekly.used, 50);
assert.equal(parsed.quotas.review_session.used, 10);
assert.equal(parsed.quotas.spark_session.used, 75);
assert.ok(parsed.quotas.session.resetAt);

const wham = parseCodexUsage({
  plan_type: 'free',
  rate_limit: {
    primary_window: { used_percent: 82, reset_at: 1_800_000_000 },
    secondary_window: { used_percent: 45, reset_at: 1_801_000_000 },
  },
});
assert.equal(wham.plan, 'free');
assert.equal(wham.quotas.session.used, 82);
assert.equal(wham.quotas.weekly.used, 45);

const legacy = parseCodexUsage({ rate_limit: { used_percent: 12, reset_at: 1_800_000_000 } });
assert.equal(legacy.quotas.session.used, 12);
assert.equal(legacy.quotas.weekly.used, 12);

assert.match(parseCodexUsage({ hello: 'world' }).error, /no recognized limits/);
assert.match(parseCodexUsage(null).error, /invalid JSON/);
console.log('codex-usage pure tests passed');
