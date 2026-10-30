import { readJson, sendError, sendJson } from '../lib/http.js';
import {
  appendChatMessage,
  createChatSession,
  deleteChatSession,
  getChatSession,
  listChatSessions,
  updateChatSession,
} from '../lib/chat-history.js';

export function handleListChatSessions(req, res) {
  return sendJson(res, 200, { sessions: listChatSessions() });
}

export async function handleCreateChatSession(req, res) {
  let body;
  try { body = await readJson(req, 64 * 1024); } catch (err) { return sendError(res, err.status || 400, err.message); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return sendError(res, 400, 'Session must be a JSON object.');
  return sendJson(res, 201, { session: createChatSession(body) });
}

export function handleGetChatSession(req, res, id) {
  const result = getChatSession(decodeURIComponent(id));
  if (!result) return sendError(res, 404, 'Chat session not found.');
  return sendJson(res, 200, result);
}

export async function handleUpdateChatSession(req, res, id) {
  let body;
  try { body = await readJson(req, 32 * 1024); } catch (err) { return sendError(res, err.status || 400, err.message); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return sendError(res, 400, 'Session update must be a JSON object.');
  const unknown = Object.keys(body).find((key) => !['title', 'model', 'archived'].includes(key));
  if (unknown) return sendError(res, 400, `Unknown session field "${unknown}".`);
  const session = updateChatSession(decodeURIComponent(id), body);
  if (!session) return sendError(res, 404, 'Chat session not found.');
  return sendJson(res, 200, { session });
}

export function handleDeleteChatSession(req, res, id) {
  if (!deleteChatSession(decodeURIComponent(id))) return sendError(res, 404, 'Chat session not found.');
  return sendJson(res, 200, { deleted: decodeURIComponent(id) });
}

export async function handleAppendChatMessage(req, res, id) {
  let body;
  try { body = await readJson(req, 4 * 1024 * 1024); } catch (err) { return sendError(res, err.status || 400, err.message); }
  const result = appendChatMessage(decodeURIComponent(id), body || {});
  if (result.error) return sendError(res, result.status || 400, result.error);
  return sendJson(res, 201, result);
}
