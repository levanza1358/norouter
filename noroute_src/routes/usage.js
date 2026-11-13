import { sendError, sendJson } from '../lib/http.js';
import { USAGE_RANGES, usageReport } from '../lib/usage.js';
import { getProvider } from '../providers/index.js';

function parseRange(res, url) {
  const range = url.searchParams.get('range') || 'day';
  if (!USAGE_RANGES.includes(range)) {
    sendJson(res, 400, {
      error: {
        message: `Unknown range "${range}". Use one of: ${USAGE_RANGES.join(', ')}.`,
        type: 'invalid_request_error',
      },
    });
    return null;
  }
  return range;
}

export function handleUsage(req, res, url) {
  const range = parseRange(res, url);
  if (!range) return undefined;
  return sendJson(res, 200, usageReport(range));
}

// GET /api/providers/:id/usage?range=day|week|month|all
export function handleProviderUsage(req, res, rawId, url) {
  const provider = getProvider(decodeURIComponent(rawId));
  if (!provider) return sendError(res, 404, `Unknown provider "${rawId}"`);
  const range = parseRange(res, url);
  if (!range) return undefined;
  return sendJson(res, 200, usageReport(range, Date.now(), { provider: provider.id }));
}
