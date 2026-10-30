// CodeBuddy CN upstream calls that are not chat: token refresh and the billing
// quota endpoint. Kept in one module so the account pool does not have to know
// the shape of Tencent's payloads.

const TIMEOUT_MS = 15000;

// Test-only overrides, so the smoke suite can point refresh and quota at the
// local stub without changing provider config.
function refreshUrl(provider) {
  return process.env.CODEBUDDY_CN_REFRESH_URL?.trim() || provider.refresh?.url || '';
}

function quotaUrl(provider) {
  return process.env.CODEBUDDY_CN_QUOTA_URL?.trim() || provider.quota?.url || '';
}

function checkinUrl(provider) {
  return process.env.CODEBUDDY_CN_CHECKIN_URL?.trim() || provider.checkin?.url || '';
}

export function hasRefreshEndpoint(provider) {
  return Boolean(refreshUrl(provider));
}

export function hasQuotaEndpoint(provider) {
  return Boolean(quotaUrl(provider));
}

function withTimeout(signal, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return {
    signal: controller.signal,
    done: () => clearTimeout(timer),
  };
}

// Exchanges a refresh token for a fresh access token. The CLI sends the token
// in X-Refresh-Token with an empty JSON body, and answers { code: 0, data }.
export async function refreshCodebuddyToken(provider, refreshToken) {
  if (!refreshToken) return { error: 'No refresh token stored for this account.' };
  const url = refreshUrl(provider);
  if (!url) return { error: 'This provider has no refresh endpoint.' };

  const timeout = withTimeout(null, TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...provider.refresh.headers,
        'X-Refresh-Token': refreshToken,
      },
      body: '{}',
      signal: timeout.signal,
    });
    const text = await response.text();

    if (!response.ok) {
      return { error: `Refresh endpoint answered ${response.status}: ${text.slice(0, 200)}`, status: response.status };
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return { error: 'Refresh endpoint returned a non-JSON body.' };
    }

    if (payload?.code !== 0 || !payload?.data?.accessToken) {
      return { error: payload?.msg || `Refresh failed (code ${payload?.code ?? '?'}).` };
    }

    return {
      accessToken: payload.data.accessToken,
      refreshToken: payload.data.refreshToken || refreshToken,
      expiresIn: Number(payload.data.expiresIn) || null,
    };
  } catch (err) {
    return {
      error: err.name === 'AbortError'
        ? 'Refresh endpoint timed out.'
        : `Could not reach the refresh endpoint: ${err.message}`,
    };
  } finally {
    timeout.done();
  }
}

function toMs(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function num(precise, plain) {
  const value = Number(precise ?? plain);
  return Number.isFinite(value) ? value : 0;
}

function cadence(start, end) {
  if (!start || !end) return 'Monthly';
  const days = (end - start) / 86400000;
  if (days <= 1.5) return 'Daily';
  if (days <= 10) return 'Weekly';
  return 'Monthly';
}

// Tencent returns two kinds of packages that must not be merged:
//   - refill packs, which reset on a cycle (use the Cycle* numbers)
//   - bonus packs, one-shot credits that expire (use the plain numbers)
export function parseCodebuddyQuota(payload) {
  if (payload?.code !== 0) {
    return { error: payload?.msg || `Quota endpoint returned code ${payload?.code ?? '?'}.` };
  }

  const accounts = payload?.data?.Response?.Data?.Accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return { plan: 'CodeBuddy', packages: [], used: 0, total: 0, resetAt: null };
  }

  const REFILL_GAP_MS = 2 * 86400000;
  const rows = accounts.map((acc) => {
    const cycleEnd = toMs(acc.CycleEndTime);
    const deductionEnd = toMs(acc.DeductionEndTime);
    const refill = cycleEnd != null && deductionEnd != null && deductionEnd - cycleEnd > REFILL_GAP_MS;
    return {
      refill,
      name: refill
        ? cadence(toMs(acc.CycleStartTime), cycleEnd)
        : 'Bonus',
      used: refill
        ? num(acc.CycleCapacityUsedPrecise, acc.CycleCapacityUsed)
        : num(acc.CapacityUsedPrecise, acc.CapacityUsed),
      total: refill
        ? num(acc.CycleCapacitySizePrecise, acc.CycleCapacitySize)
        : num(acc.CapacitySizePrecise, acc.CapacitySize),
      resetAt: cycleEnd,
      recurring: refill,
      plan: acc.PackageName || acc.SubProductName || '',
    };
  });

  const refills = rows.filter((r) => r.refill);
  const bonuses = rows.filter((r) => !r.refill);

  const packages = [];
  const seen = new Map();
  for (const row of refills) {
    const count = (seen.get(row.name) || 0) + 1;
    seen.set(row.name, count);
    packages.push({ ...row, name: count > 1 ? `${row.name} ${count}` : row.name });
  }
  bonuses.forEach((row, i) => {
    packages.push({ ...row, name: `Bonus pack ${i + 1}` });
  });

  const used = packages.reduce((sum, p) => sum + p.used, 0);
  const total = packages.reduce((sum, p) => sum + p.total, 0);
  const resetAt = packages
    .map((p) => p.resetAt)
    .filter((v) => v != null)
    .sort((a, b) => a - b)[0] || null;

  return {
    plan: refills[0]?.plan || accounts[0]?.PackageName || 'CodeBuddy',
    packages,
    used,
    total,
    resetAt,
  };
}

// Calls the billing endpoint. Also serves as a credential probe: a dead token
// answers 401/403 here without spending chat quota.
export async function fetchCodebuddyQuota(provider, accessToken) {
  const url = quotaUrl(provider);
  if (!url) return { error: 'This provider publishes no quota endpoint.' };

  const timeout = withTimeout(null, TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...provider.headers,
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: '{}',
      signal: timeout.signal,
    });
    const text = await response.text();

    if (response.status === 401 || response.status === 403) {
      return { error: 'Credential rejected by CodeBuddy (401/403).', invalid: true, status: response.status };
    }
    if (!response.ok) {
      return { error: `Quota endpoint answered ${response.status}: ${text.slice(0, 200)}`, status: response.status };
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return { error: 'Quota endpoint returned a non-JSON body.' };
    }
    return parseCodebuddyQuota(payload);
  } catch (err) {
    return {
      error: err.name === 'AbortError'
        ? 'Quota endpoint timed out.'
        : `Could not reach the quota endpoint: ${err.message}`,
    };
  } finally {
    timeout.done();
  }
}

function jwtSubject(token) {
  const encoded = String(token || '').split('.')[1];
  if (!encoded) return '';
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return typeof payload?.sub === 'string' ? payload.sub.trim() : '';
  } catch {
    return '';
  }
}

// This host and header shape follows the observed CodeBuddy web check-in flow.
// It is separate from the copilot.tencent.com chat and quota gateway.
export async function dailyCodebuddyCheckin(provider, accessToken, uid = '') {
  const url = checkinUrl(provider);
  if (!url) return { error: 'This provider has no daily check-in endpoint.' };

  const userId = jwtSubject(accessToken) || String(uid || '').trim();
  if (!userId) return { error: 'Daily check-in needs an OAuth token with a user ID or an account uid.' };

  const timeout = withTimeout(null, TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${accessToken}`,
        'X-User-Id': userId,
        'User-Agent': provider.headers?.['User-Agent'] || 'Mozilla/5.0',
        'X-Domain': 'www.codebuddy.cn',
        'X-CodeBuddy-Request': '1',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      body: '{}',
      signal: timeout.signal,
    });
    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      return { error: 'Credential rejected by CodeBuddy (401/403).', invalid: true, status: response.status };
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      if (!response.ok) {
        return { error: `Daily check-in endpoint answered ${response.status}: ${text.slice(0, 200)}`, status: response.status };
      }
      return { error: 'Daily check-in endpoint returned a non-JSON body.' };
    }
    const code = Number(payload?.code);
    const message = String(payload?.msg || payload?.message || 'Daily check-in completed.');
    if (code === 0) return { status: 'checked-in', message };
    // CodeBuddy returns an HTTP 400 for an already-claimed day.
    if (code === 10001 || code === 14001 || /already|已.*签到/i.test(message)) {
      return { status: 'already', message: 'Daily check-in was already claimed today.' };
    }
    if (code === 1003) return { status: 'inactive', message: 'Daily check-in is not active right now.' };
    if (!response.ok) {
      return { error: `Daily check-in endpoint answered ${response.status}: ${text.slice(0, 200)}`, status: response.status };
    }
    return { error: message || `Daily check-in failed (code ${payload?.code ?? '?'}).` };
  } catch (err) {
    return {
      error: err.name === 'AbortError'
        ? 'Daily check-in endpoint timed out.'
        : `Could not reach the daily check-in endpoint: ${err.message}`,
    };
  } finally {
    timeout.done();
  }
}
