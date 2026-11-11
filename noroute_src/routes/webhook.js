import { readJson, sendError, sendJson } from '../lib/http.js';
import { getWebhookSettings, setWebhookSettings, validateWebhookPatch } from '../lib/webhook.js';

export function handleWebhookGet(req, res) {
  return sendJson(res, 200, getWebhookSettings());
}

export async function handleWebhookUpdate(req, res) {
  let body;
  try {
    body = await readJson(req, 16 * 1024);
  } catch (err) {
    return sendError(res, err.status || 400, err.message);
  }
  const error = validateWebhookPatch(body);
  if (error) return sendError(res, 400, error);
  return sendJson(res, 200, setWebhookSettings(body));
}
