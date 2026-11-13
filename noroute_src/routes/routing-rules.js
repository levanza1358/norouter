// Admin endpoints for general routing rules. They share the combo page's
// enabled-model catalog and expose only the API key id/name pairs a rule may
// match on — never a secret.
import { listApiKeys } from '../lib/api-keys.js';
import { listCombos } from '../lib/combos.js';
import { readJson, sendError, sendJson } from '../lib/http.js';
import { getRoutingRules, updateRoutingRules, validateRoutingRulesPatch } from '../lib/routing-rules.js';
import { comboCatalog } from './combos.js';

function routingPayload() {
  return {
    routing: getRoutingRules(),
    catalog: comboCatalog(),
    combos: listCombos().map((combo) => combo.name),
    keys: listApiKeys().map((key) => ({ id: key.id, name: key.name })),
  };
}

export function handleGetRoutingRules(req, res) {
  return sendJson(res, 200, routingPayload());
}

export async function handleUpdateRoutingRules(req, res) {
  let body;
  try {
    body = await readJson(req, 64 * 1024);
  } catch (err) {
    return sendError(res, err.status || 400, err.message);
  }
  const error = validateRoutingRulesPatch(body);
  if (error) return sendError(res, 400, error);
  const result = updateRoutingRules(body);
  if (result.error) return sendError(res, result.status, result.error);
  return sendJson(res, 200, routingPayload());
}
