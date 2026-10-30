import { readJson, sendError, sendJson } from '../lib/http.js';
import { getReplyFiltersSettings, setReplyFiltersSettings, validateReplyFiltersPatch } from '../lib/reply-filters.js';

export function handleGetReplyFilters(req, res) {
  return sendJson(res, 200, getReplyFiltersSettings());
}

export async function handleUpdateReplyFilters(req, res) {
  let body;
  try {
    body = await readJson(req, 32 * 1024);
  } catch (err) {
    return sendError(res, err.status || 400, err.message);
  }
  const error = validateReplyFiltersPatch(body);
  if (error) return sendError(res, 400, error);
  return sendJson(res, 200, setReplyFiltersSettings(body));
}
