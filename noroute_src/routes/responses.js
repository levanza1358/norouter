// Inbound Responses API. A Responses client is translated down to the Chat
// Completions pipeline and its reply is rebuilt in the Responses shape, so
// routing, pooling, fallback and vision keep working unchanged.
import { Readable } from 'node:stream';
import { CORS_HEADERS, readJson, sendError, sendJson } from '../lib/http.js';
import {
  closeResponsesStream,
  createResponsesOutState,
  fromResponsesRequest,
  toResponsesResponse,
  toResponsesStream,
} from '../lib/responses-format.js';
import { handleChat } from './chat.js';

export async function handleResponses(req, res, settings, auth) {
  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    return sendError(res, err.status || 400, err.message);
  }

  let chatBody;
  try {
    chatBody = fromResponsesRequest(body);
  } catch (err) {
    return sendError(res, err.status || 400, err.message);
  }

  // handleChat reads `req` only through readJson, so the converted body can be
  // replayed as a one-shot stream instead of duplicating the whole pipeline.
  const upstream = Readable.from([Buffer.from(JSON.stringify(chatBody), 'utf8')]);
  upstream.method = req.method;
  upstream.url = req.url;
  upstream.headers = req.headers;

  return handleChat(upstream, createResponsesSink(res), settings, auth);
}

// The chat pipeline speaks HTTP through a small set of members. This sink
// behaves like a response while holding the bytes back, so a stream that fails
// before its first chunk can still be reported with a real error status.
function createResponsesSink(res) {
  const state = createResponsesOutState();
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
        if (!state.completed && !state.failed) emit(closeResponsesStream(state));
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
      emit(closeResponsesStream(state));
      return;
    }
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      return;
    }
    emit(toResponsesStream(chunk, state));
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
      return sendJson(res, status >= 400 ? status : 502, payload);
    }
    if (status < 200 || status >= 300) {
      return sendJson(res, status, payload ?? { error: { message: 'Upstream returned an empty response.', type: 'upstream_error' } });
    }
    if (!payload) {
      return sendError(res, 502, 'Upstream returned an empty response.');
    }
    try {
      return sendJson(res, 200, toResponsesResponse(payload));
    } catch (err) {
      return sendError(res, 502, err.message);
    }
  }

  return sink;
}
