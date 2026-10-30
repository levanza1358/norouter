import { readJson, sendError, sendJson } from '../lib/http.js';
import { getTokenSaverSettings, setTokenSaverSettings, validateTokenSaverPatch } from '../lib/token-saver.js';

export function handleGetTokenSaver(req, res) {
  return sendJson(res, 200, getTokenSaverSettings());
}

export async function handleUpdateTokenSaver(req, res) {
  let body;
  try {
    body = await readJson(req, 32 * 1024);
  } catch (err) {
    return sendError(res, err.status || 400, err.message);
  }
  const error = validateTokenSaverPatch(body);
  if (error) return sendError(res, 400, error);
  return sendJson(res, 200, setTokenSaverSettings(body));
}
