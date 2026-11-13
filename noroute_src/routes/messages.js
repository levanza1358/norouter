// Inbound Anthropic Messages API. A Messages client is translated down to the
// Chat Completions pipeline and its reply is rebuilt in the Messages shape, so
// routing, pooling, fallback, vision, and truncation handling keep working.
import { Readable } from 'node:stream';
import { CORS_HEADERS, readJson, sendJson } from '../lib/http.js';
import {
  closeAnthropicStream,
  createAnthropicOutState,
  fromAnthropicRequest,
  toAnthropicResponse,
  toAnthropicStream,
} from '../lib/anthropic-format.js';
import { handleChat } from './chat.js';

const ERROR_TYPES = new Map([
  ['invalid_request_error', 'invalid_request_error'],
  ['authentication_error', 'authentication_error'],
  ['permission_error', 'permission_error'],
  ['not_found_error', 'not_found_error'],
  ['request_too_large', 'request_too_large'],
  ['rate_limit', 'rate_limit_error'],
  ['rate_limit_error', 'rate_limit_error'],
  ['overloaded_error', 'overloaded_error'],
]);

function sendAnthropicError(res, status, message, type) {
  const mapped = ERROR_TYPES.get(String(type || '')) || (status >= 500 ? 'api_error' : 'invalid_request_error');
  return sendJson(res, status, { type: 'error', error: { type: mapped, message } });
}

export async function handleMessages(req, res, settings, auth) {
  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    return sendAnthropicError(res, err.status || 400, err.message);
  }

  let chatBody;
  try {
    chatBody = fromAnthropicRequest(body);
  } catch (err) {
    return sendAnthropicError(res, err.status || 400, err.message);
  }

  // handleChat reads `req` only through readJson, so the converted body can be
  // replayed as a one-shot stream instead of duplicating the whole pipeline.
  const upstream = Readable.from([Buffer.from(JSON.stringify(chatBody), 'utf8')]);
  upstream.method = req.method;
  upstream.url = req.url;
  upstream.headers = req.headers;

  return handleChat(upstream, createMessagesSink(res), settings, auth);
}

// The chat pipeline speaks HTTP through a small set of members. This sink
// behaves like a response while holding the bytes back, so a stream that fails
// before its first chunk can still be reported with a real error status.
function createMessagesSink(res) {
  const state = createAnthropicOutState();
  const closeListeners = new Set();
  let status = 200;
  let stream = false;
  let headersSent = false;
  let writableEnded = false;
  let destroyed = false;
  let committed = false;
  let pending = '';

  const sink = {
    get headersSent() {
      return headersSent;
    },
    get writableEnded() {
      return writableEnded;
    },
    get destroyed() {
      return destroyed;
    },
    writeHead(code, headers = {}) {
      if (headersSent) return sink;
      status = Number(code) || 200;
      headersSent = true;
      stream = /text\/event-stream/i.test(String(headers['content-type'] || ''));
      return sink;
    },
    write(chunk) {
      if (writableEnded || destroyed) return true;
      const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
      if (stream) consumeStream(text);
      return true;
    },
    end(chunk) {
      if (writableEnded) return sink;
      writableEnded = true;
      const text = chunk === undefined ? '' : typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (stream) {
        if (text) consumeStream(text);
        if (!state.completed && !state.failed) emit(closeAnthropicStream(state));
        if (!res.writableEnded) res.end();
      } else {
        finishJson(text);
      }
      return sink;
    },
    on(event, listener) {
      if (event === 'close' && typeof listener === 'function') closeListeners.add(listener);
      return sink;
    },
    off(event, listener) {
      if (event === 'close') closeListeners.delete(listener);
      return sink;
    },
  };

  res.on('close', () => {
    destroyed = !res.writableEnded;
    for (const listener of closeListeners) {
      try {
        listener();
      } catch {
        // A failing cleanup must not break response teardown.
      }
    }
  });

  function commit() {
    if (committed) return true;
    if (res.writableEnded || res.destroyed) return false;
    committed = true;
    res.writeHead(200, {
      ...CORS_HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    return true;
  }

  function emit(events) {
    if (!events.length || !commit()) return;
    for (const event of events) {
      if (res.writableEnded || res.destroyed) return;
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
  }

  function consumeStream(text) {
    pending += text.replace(/\r\n/g, '\n');
    while (true) {
      const breakAt = pending.indexOf('\n');
      if (breakAt < 0) return;
      const line = pending.slice(0, breakAt).trim();
      pending = pending.slice(breakAt + 1);
      if (line) relayLine(line);
    }
  }

  function relayLine(line) {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    if (payload === '[DONE]') {
      emit(closeAnthropicStream(state));
      return;
    }
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      return;
    }
    emit(toAnthropicStream(chunk, state));
  }

  function finishJson(text) {
    if (res.writableEnded || res.destroyed) return;
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (payload?.error) {
      return sendAnthropicError(res, status >= 400 ? status : 502, payload.error.message || 'Upstream request failed.', payload.error.type);
    }
    if (status < 200 || status >= 300) {
      return sendAnthropicError(res, status, payload?.error?.message || 'Upstream request failed.', payload?.error?.type);
    }
    if (!payload) {
      return sendAnthropicError(res, 502, 'Upstream returned an empty response.', 'api_error');
    }
    try {
      return sendJson(res, 200, toAnthropicResponse(payload));
    } catch (err) {
      return sendAnthropicError(res, 502, err.message, 'api_error');
    }
  }

  return sink;
}
