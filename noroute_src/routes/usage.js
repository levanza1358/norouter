import { sendJson } from '../lib/http.js';
import { USAGE_RANGES, usageReport } from '../lib/usage.js';

export function handleUsage(req, res, url) {
  const range = url.searchParams.get('range') || 'day';
  if (!USAGE_RANGES.includes(range)) {
    return sendJson(res, 400, {
      error: {
        message: `Unknown range "${range}". Use one of: ${USAGE_RANGES.join(', ')}.`,
        type: 'invalid_request_error',
      },
    });
  }
  return sendJson(res, 200, usageReport(range));
}
