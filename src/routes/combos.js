import { readJson, sendError, sendJson } from '../lib/http.js';
import { createCombo, deleteCombo, getCombo, listCombos, updateCombo } from '../lib/combos.js';
import { allModels, providers } from '../providers/index.js';

// Models a combo may reference: exactly the enabled catalog, provider-prefixed
// the same way /v1/models presents them. Served here because the dashboard's
// admin routes are not behind REQUIRE_API_KEY, while /v1/models is.
function comboCatalog() {
  const models = [];
  for (const provider of providers) {
    for (const model of allModels(provider)) {
      models.push({ id: `${provider.prefix}/${model}`, provider: provider.id, model });
    }
  }
  return models;
}

export function handleListCombos(req, res) {
  sendJson(res, 200, { combos: listCombos(), catalog: comboCatalog() });
}

export async function handleCreateCombo(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    return sendError(res, err.status || 400, err.message);
  }
  const result = createCombo(body);
  if (result.error) return sendError(res, result.status, result.error);
  return sendJson(res, 201, { combo: result.combo });
}

export async function handleUpdateCombo(req, res, id) {
  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    return sendError(res, err.status || 400, err.message);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return sendError(res, 400, 'Combo update must be a JSON object.');
  }
  const unknown = Object.keys(body).find((key) => key !== 'name' && key !== 'models');
  if (unknown) return sendError(res, 400, `Unknown combo field "${unknown}".`);

  const result = updateCombo(id, body);
  if (result.error) return sendError(res, result.status, result.error);
  return sendJson(res, 200, { combo: result.combo });
}

export function handleDeleteCombo(req, res, id) {
  const result = deleteCombo(id);
  if (result.error) return sendError(res, result.status, result.error);
  return sendJson(res, 200, { deleted: result.combo.id, combo: result.combo });
}

export function handleGetCombo(req, res, id) {
  const combo = getCombo(id);
  if (!combo) return sendError(res, 404, `Unknown combo "${id}".`);
  return sendJson(res, 200, { combo });
}
