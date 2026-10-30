// Pure parser for the ChatGPT/Codex WHAM usage response.

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resetAt(value) {
  if (value == null) return null;
  const parsed = typeof value === 'number' ? value * (value < 10_000_000_000 ? 1000 : 1) : Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function windowQuota(raw = {}) {
  const used = number(raw.used_percent ?? raw.percent_used ?? raw.used ?? raw.usage_percent);
  const totalRaw = number(raw.total ?? raw.limit ?? raw.capacity);
  const unlimited = raw.unlimited === true || raw.is_unlimited === true || totalRaw === 0;
  const total = unlimited ? 100 : totalRaw ?? 100;
  const normalizedUsed = used == null ? null : Math.max(0, Math.min(total, used <= 1 ? used * total : used));
  return {
    used: normalizedUsed,
    total,
    remaining: normalizedUsed == null ? null : Math.max(0, total - normalizedUsed),
    resetAt: resetAt(raw.reset_at ?? raw.resets_at ?? raw.resetAt),
    unlimited,
  };
}

function findWindow(source, names) {
  if (!source || typeof source !== 'object') return null;
  for (const name of names) {
    if (source[name] && typeof source[name] === 'object') return source[name];
  }
  return null;
}

function hasUsageWindow(value) {
  return Boolean(value && typeof value === 'object' && (
    value.used_percent != null
    || value.percent_used != null
    || value.used != null
    || value.usage_percent != null
    || value.reset_at != null
    || value.resets_at != null
    || value.resetAt != null
  ));
}

export function parseCodexUsage(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: 'Codex quota endpoint returned an invalid JSON object.' };
  }
  if (payload.error) return { error: String(payload.error.message || payload.error) };
  const limits = payload.rate_limits_by_limit_id || payload.rate_limits || payload;
  const base = payload.rate_limit || limits.codex || limits.default || limits;
  const review = payload.code_review_rate_limit || payload.review_rate_limit || limits.review || limits.code_review;
  const spark = payload.spark_rate_limit || payload.gpt_5_3_codex_spark_rate_limit || limits.spark;
  const sessionRaw = findWindow(base, ['session', 'session_limit', 'primary', 'primary_window']) || base?.primary_window || base;
  const weeklyRaw = findWindow(base, ['weekly', 'week', 'weekly_limit', 'secondary', 'secondary_window']) || base?.secondary_window;
  const session = windowQuota(sessionRaw);
  const weekly = weeklyRaw ? windowQuota(weeklyRaw) : { ...session };
  const quotas = { session, weekly };
  if (review) {
    quotas.review_session = windowQuota(findWindow(review, ['session', 'primary', 'primary_window']) || review);
    const reviewWeekly = findWindow(review, ['weekly', 'week', 'secondary', 'secondary_window']);
    if (reviewWeekly) quotas.review_weekly = windowQuota(reviewWeekly);
  }
  if (spark) {
    quotas.spark_session = windowQuota(findWindow(spark, ['session', 'primary', 'primary_window']) || spark);
    const sparkWeekly = findWindow(spark, ['weekly', 'week', 'secondary', 'secondary_window']);
    if (sparkWeekly) quotas.spark_weekly = windowQuota(sparkWeekly);
  }
  if (!hasUsageWindow(sessionRaw) && !hasUsageWindow(weeklyRaw) && !hasUsageWindow(review) && !hasUsageWindow(spark)) {
    return { error: 'Codex quota response contained no recognized limits.' };
  }
  return {
    plan: payload.plan_type || payload.summary?.plan || payload.plan || 'ChatGPT',
    limitReached: payload.limit_reached === true || payload.limitReached === true,
    reviewLimitReached: payload.review_limit_reached === true,
    sparkLimitReached: payload.spark_limit_reached === true,
    quotas,
  };
}
