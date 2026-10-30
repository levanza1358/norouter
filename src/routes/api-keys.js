import { readJson, sendError, sendJson } from '../lib/http.js';
import {
  apiKeyUsage,
  createApiKey,
  getRequireApiKey,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
  setRequireApiKey,
  updateApiKey,
} from '../lib/api-keys.js';

export function handleListApiKeys(req, res) {
  return sendJson(res, 200, { keys: listApiKeys() });
}

export async function handleCreateApiKey(req, res) {
  let body;
  try { body = await readJson(req, 16 * 1024); } catch (err) { return sendError(res, err.status || 400, err.message); }
  const result = createApiKey(body || {});
  if (result.error) return sendError(res, result.status, result.error);
  return sendJson(res, 201, result);
}

export async function handleUpdateApiKey(req, res, id) {
  let body;
  try { body = await readJson(req, 16 * 1024); } catch (err) { return sendError(res, err.status || 400, err.message); }
  const result = updateApiKey(decodeURIComponent(id), body || {});
  if (!result) return sendError(res, 404, 'API key not found.');
  if (result.error) return sendError(res, result.status, result.error);
  return sendJson(res, 200, { key: result });
}

export async function handleRotateApiKey(req, res, id) {
  let body;
  try { body = await readJson(req, 16 * 1024); } catch (err) { return sendError(res, err.status || 400, err.message); }
  const result = rotateApiKey(decodeURIComponent(id), body || {});
  if (!result) return sendError(res, 404, 'API key not found.');
  if (result.error) return sendError(res, result.status, result.error);
  return sendJson(res, 200, result);
}

export function handleApiKeyUsage(req, res, id, url) {
  const key = listApiKeys().find((item) => item.id === decodeURIComponent(id));
  if (!key) return sendError(res, 404, 'API key not found.');
  return sendJson(res, 200, { key, usage: apiKeyUsage(key.id, url.searchParams.get('days')) });
}

export function handleDeleteApiKey(req, res, id) {
  const keyId = decodeURIComponent(id);
  if (!revokeApiKey(keyId)) return sendError(res, 404, 'API key not found.');
  return sendJson(res, 200, { removed: keyId });
}

export function handleGetAuthSettings(req, res, defaultValue) {
  return sendJson(res, 200, { requireApiKey: getRequireApiKey(defaultValue) });
}

export async function handleUpdateAuthSettings(req, res) {
  let body;
  try { body = await readJson(req, 16 * 1024); } catch (err) { return sendError(res, err.status || 400, err.message); }
  if (typeof body?.requireApiKey !== 'boolean') return sendError(res, 400, 'requireApiKey must be boolean.');
  return sendJson(res, 200, { requireApiKey: setRequireApiKey(body.requireApiKey) });
}
