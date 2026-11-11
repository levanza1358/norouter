import { sendJson } from '../lib/http.js';
import { clearRequestLogs, requestLogs } from '../lib/request-log.js';

export function handleRequestLog(req, res) {
  return sendJson(res, 200, { requests: requestLogs() });
}

export function handleRequestLogClear(req, res) {
  clearRequestLogs();
  return sendJson(res, 200, { cleared: true });
}
