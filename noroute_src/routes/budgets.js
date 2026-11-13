// Admin endpoints for daily budgets. The payload lists every managed key and
// every provider so the settings page can show a limit and today's usage side
// by side; secrets never leave the key store.
import { listApiKeys } from '../lib/api-keys.js';
import { budgetDay, budgetUsage, getBudgetSettings, updateBudgetSettings, validateBudgetPatch } from '../lib/budgets.js';
import { readJson, sendError, sendJson } from '../lib/http.js';
import { providers } from '../providers/index.js';

const EMPTY_USAGE = { requests: 0, tokensIn: 0, tokensOut: 0, tokens: 0, costMicro: 0, cost: 0 };

// A configured limit is shown even while budgets are switched off, so the page
// can display what would apply if they were turned back on.
function usageFor(byScope, scope, limit) {
  const used = byScope.get(scope) || EMPTY_USAGE;
  return {
    limit: limit || null,
    used,
    percent: limit?.tokens != null ? Math.min(100, Math.round((used.tokens / limit.tokens) * 100)) : null,
    costPercent: limit?.cost != null ? Math.min(100, Math.round((used.cost / limit.cost) * 100)) : null,
  };
}

function budgetPayload() {
  const settings = getBudgetSettings();
  // Today's counters include scopes that were capped earlier but are uncapped
  // now, so an operator can still see what the day already spent.
  const day = budgetDay();
  const byScope = new Map(budgetUsage(day).map((row) => [row.scope, row]));
  return {
    enabled: settings.enabled,
    day,
    keys: listApiKeys().map((key) => ({
      id: key.id,
      name: key.name,
      status: key.status,
      ...usageFor(byScope, `key:${key.id}`, settings.keys[key.id]),
    })),
    providers: providers.map((provider) => ({
      id: provider.id,
      name: provider.display.name,
      ...usageFor(byScope, `provider:${provider.id}`, settings.providers[provider.id]),
    })),
  };
}

export function handleGetBudgets(req, res) {
  return sendJson(res, 200, budgetPayload());
}

export async function handleUpdateBudgets(req, res) {
  let body;
  try {
    body = await readJson(req, 32 * 1024);
  } catch (err) {
    return sendError(res, err.status || 400, err.message);
  }
  const error = validateBudgetPatch(body);
  if (error) return sendError(res, 400, error);
  updateBudgetSettings(body);
  return sendJson(res, 200, budgetPayload());
}
