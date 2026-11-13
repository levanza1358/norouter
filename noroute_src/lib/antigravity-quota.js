// Antigravity quota — read from the Cloud Code `v1internal` endpoints.
//
// `retrieveUserQuotaSummary` is the only endpoint that reports the shared
// weekly / 5h pools every Antigravity account draws from. Free-tier accounts
// get no remainingFraction on per-model quotaInfo (only a reset time), so the
// model list is a paid-tier fallback and the summary is always tried first.
import { arch, platform } from 'node:os';

import { normalizePlan, planLabel as vocabularyLabel } from './plan.js';

const TIMEOUT_MS = 10_000;
const MAX_BODY = 2 * 1024 * 1024;

// Mirrors the metadata the IDE sends. Kept here instead of importing
// antigravity-oauth.js, which imports accounts.js and would cycle back through
// lib/quota.js into this module.
function clientMetadata() {
  const os = platform();
  const arm = arch() === 'arm64';
  const osType = os === 'darwin' ? (arm ? 2 : 1) : os === 'linux' ? (arm ? 4 : 3) : os === 'win32' ? 5 : 0;
  return { ideType: 9, platform: osType, pluginType: 2 };
}

// The family order matters: Argon has its own pool and its name also matches
// the broader Gemini pattern, so it must be checked first.
const FAMILIES = [
  {
    pattern: /argon/i,
    weekly: { key: 'gemini_argon_weekly', displayName: 'Gemini 4 Argon (Weekly)' },
    session: { key: 'gemini_argon_session', displayName: 'Gemini 4 Argon (5h)' },
  },
  {
    pattern: /gemini/i,
    weekly: { key: 'gemini_weekly', displayName: 'Gemini (Weekly)' },
    session: { key: 'gemini_session', displayName: 'Gemini (5h)' },
  },
  {
    pattern: /claude|gpt/i,
    weekly: { key: 'claude_gpt_weekly', displayName: 'Claude & GPT (Weekly)' },
    session: { key: 'claude_gpt_session', displayName: 'Claude & GPT (5h)' },
  },
];

// Tests and local gateways point ANTIGRAVITY_BASE_URL at their own host, so
// every Cloud Code path follows that override.
function endpoint(provider, key, path) {
  const base = String(process.env[provider.baseUrlEnv] || '').trim().replace(/\/+$/, '');
  return base ? `${base}${path}` : provider.quota[key];
}

function headers(provider, accessToken, quota = false) {
  const agent = provider.headers?.['User-Agent'] || provider.oauth?.loadCodeAssistUserAgent || 'antigravity';
  const result = {
    accept: 'application/json',
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    'user-agent': agent,
    'x-request-source': 'local',
  };
  if (quota) {
    result['x-client-name'] = 'antigravity';
    if (provider.quota?.clientVersion) result['x-client-version'] = provider.quota.clientVersion;
  }
  return result;
}

async function postJson(url, requestHeaders, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    let body = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = null; }
    }
    if (!response.ok) {
      const message = body?.error?.message || body?.message;
      return {
        error: typeof message === 'string' ? message : `Quota endpoint returned HTTP ${response.status}.`,
        status: response.status,
      };
    }
    if (text.length > MAX_BODY) return { error: 'Quota response is too large.' };
    if (body == null) return { error: 'Quota endpoint returned invalid JSON.' };
    return body;
  } catch (err) {
    return { error: err.name === 'AbortError' ? 'Quota endpoint timed out.' : 'Quota endpoint could not be reached.' };
  } finally {
    clearTimeout(timer);
  }
}

function resetAt(value) {
  if (value == null) return null;
  const parsed = typeof value === 'number' ? value * (value < 10_000_000_000 ? 1000 : 1) : Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function projectFrom(body) {
  const raw = body?.cloudaicompanionProject;
  return String((typeof raw === 'object' && raw ? raw.id : raw) || '').trim();
}

// The quota tab shows one line per account, so the tier label follows the same
// vocabulary as the account badge: `free-tier` is Free, `g1-plus-tier` and
// `g1-pro-tier` are Plus/Pro, and an unnamed tier keeps Google's own name.
function tierLabel(tier) {
  const id = String(tier?.id || '').trim();
  const plan = normalizePlan(id || tier?.name);
  if (plan === 'free') return 'Free tier';
  if (plan === 'unknown') return String(tier?.name || id).trim() || 'Antigravity';
  return `${vocabularyLabel(plan)} tier`;
}

// Antigravity logins always report `currentTier: free-tier`; the Google One
// plan that actually bills the account arrives in `paidTier`. Read the paid
// tier first and fall back to `currentTier` for logins that report their paid
// tier there instead (Code Assist names it `standard-tier`).
export function antigravityTier(body) {
  const paid = body?.paidTier && typeof body.paidTier === 'object' ? body.paidTier : null;
  const current = body?.currentTier && typeof body.currentTier === 'object' ? body.currentTier : null;
  if (paid && normalizePlan(paid.id) !== 'free') return paid;
  return current || paid;
}

function windowQuota(bucket, label) {
  const remaining = Math.min(1, Math.max(0, Number(bucket.remainingFraction)));
  const used = Math.round((1 - remaining) * 100);
  return {
    used,
    total: 100,
    resetAt: resetAt(bucket.resetTime),
    unlimited: false,
    displayName: label,
  };
}

// Summary rows are shared pools per model family, not per model. Bucket ids
// are not stable API surface, so family and window are matched by name.
export function parseAntigravitySummary(data) {
  const groups = Array.isArray(data?.groups)
    ? data.groups
    : Array.isArray(data?.quotaSummary?.groups)
      ? data.quotaSummary.groups
      : [];
  const quotas = {};
  for (const group of groups) {
    if (!group || typeof group !== 'object') continue;
    const groupName = String(group.displayName || '');
    for (const bucket of Array.isArray(group.buckets) ? group.buckets : []) {
      if (!bucket || typeof bucket !== 'object') continue;
      const windowType = String(bucket.window || '').toLowerCase();
      const bucketText = `${bucket.bucketId || ''} ${bucket.displayName || ''}`.toLowerCase();
      const weekly = windowType === 'weekly' || bucketText.includes('weekly');
      const session = windowType === '5h' || windowType === 'daily'
        || bucketText.includes('five hour') || bucketText.includes('5h') || bucketText.includes('daily');
      if (!weekly && !session) continue;
      // A disabled weekly pool is gone until it resets upstream; a disabled
      // session pool still belongs in the list as fully used.
      if (bucket.disabled === true && weekly) continue;
      const fraction = bucket.disabled === true ? 0 : Number(bucket.remainingFraction);
      if (!Number.isFinite(fraction)) continue;
      for (const family of FAMILIES) {
        if (!family.pattern.test(groupName)) continue;
        const target = weekly ? family.weekly : family.session;
        if (!quotas[target.key]) quotas[target.key] = windowQuota({ ...bucket, remainingFraction: fraction }, target.displayName);
        break;
      }
    }
  }
  return quotas;
}

// Paid-tier fallback: per-model quotaInfo does carry a remaining fraction.
// Rows are ranked tightest first and capped so the tab stays readable.
export function parseAntigravityModels(data) {
  const quotas = {};
  const seen = new Set();
  const rows = [];
  for (const [modelId, info] of Object.entries(data?.models || {})) {
    if (!info || typeof info !== 'object' || info.isInternal) continue;
    const fraction = Number(info.quotaInfo?.remainingFraction);
    if (!Number.isFinite(fraction)) continue;
    rows.push({
      modelId,
      fraction,
      label: String(info.displayName || modelId),
      resetAt: resetAt(info.quotaInfo?.resetTime),
    });
  }
  rows.sort((a, b) => a.fraction - b.fraction);
  for (const row of rows.slice(0, 10)) {
    const label = row.label;
    if (seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    quotas[`model_${row.modelId}`] = {
      used: Math.round((1 - Math.min(1, Math.max(0, row.fraction))) * 100),
      total: 100,
      resetAt: row.resetAt,
      unlimited: false,
      displayName: label,
    };
  }
  return quotas;
}

export async function fetchAntigravityQuota(provider, accessToken, account = {}) {
  // loadCodeAssist is best-effort: quota still works from the stored project
  // when the tier lookup fails, and chat must never be blocked by it.
  const projectUrl = endpoint(provider, 'projectUrl', '/v1internal:loadCodeAssist');
  const session = await postJson(projectUrl, headers(provider, accessToken), { metadata: clientMetadata(), mode: 1 });
  const projectId = session.error ? '' : projectFrom(session) || String(account.project_id || '').trim();
  // `currentTier` stays free-tier for Antigravity logins, so the subscription
  // label comes from the Google One plan in `paidTier`.
  const tier = session.error ? null : antigravityTier(session);
  const planKey = session.error ? normalizePlan(account.plan) : normalizePlan(tier?.id);
  const plan = session.error
    ? tierLabel({ id: account.plan })
    : tierLabel(tier);
  const paid = !session.error && Boolean(String(tier?.id || '').trim()) && normalizePlan(tier.id) !== 'free';

  const summaryUrl = endpoint(provider, 'url', '/v1internal:retrieveUserQuotaSummary');
  const summary = await postJson(summaryUrl, headers(provider, accessToken, true), projectId ? { project: projectId } : {});
  if (summary.error) {
    if (summary.status === 401 || summary.status === 403) {
      return { error: 'Antigravity denied quota access; chat may still work.', status: summary.status };
    }
    return summary;
  }

  const quotas = parseAntigravitySummary(summary);
  if (!Object.keys(quotas).length && paid) {
    const modelsUrl = endpoint(provider, 'modelsUrl', '/v1internal:fetchAvailableModels');
    const models = await postJson(modelsUrl, headers(provider, accessToken, true), projectId ? { project: projectId } : {});
    if (!models.error) Object.assign(quotas, parseAntigravityModels(models));
  }

  if (!Object.keys(quotas).length) return { error: 'Antigravity returned no quota windows.' };
  // `plan` is the display label; `planKey` is the canonical tier the pool
  // stores on the account so the badge survives a failing quota read.
  return { plan: plan || 'Antigravity', planKey, quotas };
}
