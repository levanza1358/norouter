import {
  accountUsageSummary,
  bulkCreateAccounts,
  checkinProvider,
  createAccount,
  dailyCheckinForAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  listQuotaAccounts,
  previewAccounts,
  quotaForAccount,
  refreshQuotaOrder,
  restartAccount,
  testAccount,
  updateAccount,
  warmupAccount,
  warmupProvider,
} from '../lib/accounts.js';
import { readJson, sendError, sendJson } from '../lib/http.js';
import { getProvider } from '../providers/index.js';
import { pingAccount, testProviderAccounts } from '../lib/model-test.js';

function resolveProvider(res, rawId) {
  const provider = getProvider(decodeURIComponent(rawId));
  if (!provider) {
    sendError(res, 404, `Unknown provider "${rawId}"`);
    return null;
  }
  return provider;
}

function query(res, provider, url) {
  return sendJson(res, 200, {
    provider: provider.id,
    ...listAccounts(provider.id, {
      page: url.searchParams.get('page'),
      pageSize: url.searchParams.get('pageSize'),
      q: url.searchParams.get('q'),
      status: url.searchParams.get('status'),
    }),
  });
}

// GET /api/providers/:id/accounts?page=1&pageSize=20&q=&status=
export function handleListAccounts(req, res, rawId, url) {
  const provider = resolveProvider(res, rawId);
  if (!provider) return undefined;
  return query(res, provider, url);
}

// GET /api/providers/:id/accounts/quota-list?page=1&pageSize=5
// Uses only in-memory quota hints; it never exposes credentials or triggers upstream calls.
export function handleQuotaAccountList(res, rawId, url) {
  const provider = resolveProvider(res, rawId);
  if (!provider) return undefined;
  return sendJson(res, 200, {
    provider: provider.id,
    ...listQuotaAccounts(provider.id, {
      page: url.searchParams.get('page'),
      pageSize: url.searchParams.get('pageSize'),
    }),
  });
}

export async function handleRefreshQuotaOrder(res, rawId) {
  const provider = resolveProvider(res, rawId);
  if (!provider) return undefined;
  const result = await refreshQuotaOrder(provider);
  return sendJson(res, 200, result);
}

// POST /api/providers/:id/accounts/warmup
// Probes only expired parked accounts; healthy accounts are not touched.
export async function handleWarmupAccounts(res, rawId) {
  const provider = resolveProvider(res, rawId);
  if (!provider) return undefined;
  const result = await warmupProvider(provider);
  return sendJson(res, 200, { provider: provider.id, ...result });
}

// POST /api/providers/:id/accounts/test
// Sends one provider-native probe per enabled account, sequentially.
export async function handleTestAllAccounts(res, rawId) {
  const provider = resolveProvider(res, rawId);
  if (!provider) return undefined;
  return sendJson(res, 200, await testProviderAccounts(provider));
}

// POST /api/providers/:id/accounts/checkin
// Daily check-in for every OAuth account in the pool; API keys are skipped.
export async function handleCheckinAllAccounts(res, rawId) {
  const provider = resolveProvider(res, rawId);
  if (!provider) return undefined;
  if (!provider.checkin && !process.env.CODEBUDDY_CN_CHECKIN_URL?.trim()) {
    return sendError(res, 400, 'This provider has no daily check-in endpoint.');
  }
  return sendJson(res, 200, await checkinProvider(provider));
}

// POST /api/providers/:id/accounts/:id/ping
// Real per-account probe: one SSE chat turn; the upstream answer is the per-account
// proof that the account responds (rendered "Pong" by the UI).
export async function handleAccountPing(res, rawId, accountId) {
  const provider = resolveProvider(res, rawId);
  if (!provider) return undefined;
  const account = getAccount(accountId);
  if (!account || account.provider !== provider.id) {
    return sendError(res, 404, 'Account not found.');
  }
  const result = await pingAccount(provider, accountId);
  if (result.error) {
    return sendJson(res, result.status || 400, { error: { message: result.error, type: 'invalid_request_error' } });
  }
  return sendJson(res, 200, result);
}

// POST /api/providers/:id/accounts/:id/restart
// Pauses and resumes one account; resuming clears its cooldown and last error.
export function handleRestartAccount(res, rawId, accountId) {
  const provider = resolveProvider(res, rawId);
  if (!provider) return undefined;
  const account = getAccount(accountId);
  if (!account || account.provider !== provider.id) {
    return sendError(res, 404, 'Account not found.');
  }
  const result = restartAccount(accountId);
  if (result.error) return sendError(res, result.status, result.error);
  return sendJson(res, 200, { account: result.account });
}

// POST /api/providers/:id/accounts/:id/warmup
// Probes one parked/errored account with an expired cooldown only.
export async function handleAccountWarmup(res, rawId, accountId) {
  const provider = resolveProvider(res, rawId);
  if (!provider) return undefined;
  const account = getAccount(accountId);
  if (!account || account.provider !== provider.id) {
    return sendError(res, 404, 'Account not found.');
  }
  const result = await warmupAccount(provider, accountId);
  return sendJson(res, 200, { provider: provider.id, ...result });
}

// POST /api/providers/:id/accounts/preview
// Classifies incoming rows without writing SQLite or returning raw credentials.
export async function handlePreviewAccounts(req, res, rawId) {
  const provider = resolveProvider(res, rawId);
  if (!provider) return undefined;

  let body;
  try {
    body = await readJson(req, 8 * 1024 * 1024);
  } catch (err) {
    return sendError(res, err.status || 400, err.message);
  }

  const entries = Array.isArray(body)
    ? body
    : Array.isArray(body?.accounts)
      ? body.accounts
      : [body];
  if (!entries.length) return sendError(res, 400, 'No accounts in the request.');

  const result = previewAccounts(provider.id, entries, { prefix: provider.prefix });
  if (result.error) return sendError(res, result.status || 400, result.error);
  return sendJson(res, 200, { provider: provider.id, ...result });
}

// POST /api/providers/:id/accounts
// Accepts one account, or { accounts: [...] } for a bulk import. The bulk path
// is one transaction, so 1,000 rows land without 1,000 commits.
export async function handleCreateAccounts(req, res, rawId, url) {
  const provider = resolveProvider(res, rawId);
  if (!provider) return undefined;

  let body;
  try {
    body = await readJson(req, 8 * 1024 * 1024);
  } catch (err) {
    return sendError(res, err.status || 400, err.message);
  }

  const entries = Array.isArray(body)
    ? body
    : Array.isArray(body?.accounts)
      ? body.accounts
      : [body];

  if (!entries.length) return sendError(res, 400, 'No accounts in the request.');

  const result = entries.length === 1 && !Array.isArray(body?.accounts) && !Array.isArray(body)
    ? createAccount(provider.id, entries[0], {
      expiresIn: body?.expiresIn ?? body?.expires_in,
      prefix: provider.prefix,
    })
    : bulkCreateAccounts(provider.id, entries, { prefix: provider.prefix });

  if (result.error) return sendError(res, result.status || 400, result.error);

  return sendJson(res, 201, {
    provider: provider.id,
    added: result.added ?? 0,
    duplicates: result.duplicates ?? 0,
    invalid: result.invalid ?? [],
    ...listAccounts(provider.id, {
      page: url.searchParams.get('page'),
      pageSize: url.searchParams.get('pageSize'),
      q: url.searchParams.get('q'),
      status: url.searchParams.get('status'),
    }),
  });
}

export async function handleUpdateAccount(req, res, providerId, accountId) {
  const account = getAccount(accountId);
  if (!account || account.provider !== providerId) {
    return sendError(res, 404, 'Account not found.');
  }

  let body;
  try {
    body = await readJson(req, 64 * 1024);
  } catch (err) {
    return sendError(res, err.status || 400, err.message);
  }

  const result = updateAccount(accountId, body || {});
  if (result.error) return sendError(res, result.status, result.error);
  return sendJson(res, 200, { account: result.account });
}

export function handleDeleteAccount(res, providerId, accountId) {
  const account = getAccount(accountId);
  if (!account || account.provider !== providerId) {
    return sendError(res, 404, 'Account not found.');
  }
  deleteAccount(accountId);
  return sendJson(res, 200, { removed: accountId });
}

export async function handleTestAccount(res, rawId, accountId) {
  const provider = getProvider(decodeURIComponent(rawId));
  if (!provider) return sendError(res, 404, `Unknown provider "${rawId}"`);

  const account = getAccount(accountId);
  if (!account || account.provider !== provider.id) {
    return sendError(res, 404, 'Account not found.');
  }

  const result = await testAccount(provider, accountId);
  if (result.error) {
    return sendJson(res, result.status || 400, {
      error: { message: result.error, type: 'invalid_request_error' },
    });
  }
  return sendJson(res, 200, result);
}

export async function handleAccountQuota(res, rawId, accountId) {
  const provider = getProvider(decodeURIComponent(rawId));
  if (!provider) return sendError(res, 404, `Unknown provider "${rawId}"`);

  const account = getAccount(accountId);
  if (!account || account.provider !== provider.id) {
    return sendError(res, 404, 'Account not found.');
  }

  const result = await quotaForAccount(provider, accountId);
  if (result.error) {
    return sendJson(res, result.status || 400, {
      error: { message: result.error, type: 'invalid_request_error' },
    });
  }
  return sendJson(res, 200, result);
}

export async function handleAccountCheckin(res, rawId, accountId) {
  const provider = getProvider(decodeURIComponent(rawId));
  if (!provider) return sendError(res, 404, `Unknown provider "${rawId}"`);

  const account = getAccount(accountId);
  if (!account || account.provider !== provider.id) {
    return sendError(res, 404, 'Account not found.');
  }

  const result = await dailyCheckinForAccount(provider, accountId);
  if (result.error) {
    return sendJson(res, result.status || 400, {
      error: { message: result.error, type: 'invalid_request_error' },
    });
  }
  return sendJson(res, 200, result);
}

// GET /api/providers/:id/accounts/:accountId/summary
export function handleAccountSummary(res, rawId, accountId) {
  const provider = resolveProvider(res, rawId);
  if (!provider) return undefined;

  const summary = accountUsageSummary(provider.id, accountId);
  if (!summary) return sendError(res, 404, 'Account not found.');
  return sendJson(res, 200, summary);
}
