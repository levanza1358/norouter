export const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
};

export async function readJson(req, limit = 10 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw Object.assign(new Error('Request body too large'), { status: 413 });
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('Request body is not valid JSON'), { status: 400 });
  }
}

export function sendJson(res, status, payload) {
  if (res.headersSent) return res.end();
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...CORS_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function sendError(res, status, message, extra = {}) {
  sendJson(res, status, {
    error: {
      message,
      type: status >= 500 ? 'upstream_error' : 'invalid_request_error',
      ...extra,
    },
  });
}

export function sendHtml(res, status, html) {
  res.writeHead(status, {
    ...CORS_HEADERS,
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
  });
  res.end(html);
}
