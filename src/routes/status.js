import { sendJson } from '../lib/http.js';
import { statusSnapshot } from '../lib/stats.js';

export function handleStatus(req, res) {
  sendJson(res, 200, statusSnapshot());
}
