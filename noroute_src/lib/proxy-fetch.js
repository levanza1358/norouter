import http from 'node:http';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';

import { openTunnel, ProxyTransportError } from './proxy-transport.js';
import {
  getProxySettings,
  markProxyRequestFailure,
  markProxySuccess,
  noteFallbackDirect,
  noteProxied,
  noteProxyFailure,
  selectProxy,
} from './proxies.js';

const MAX_REDIRECTS = 5;
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const REPLAYABLE = (body) => body === undefined || body === null
  || typeof body === 'string' || Buffer.isBuffer(body) || ArrayBuffer.isView(body);

export class ProxyUnavailableError extends Error {
  constructor() {
    super('Proxy egress is unavailable.');
    this.name = 'ProxyUnavailableError';
    this.status = 502;
    this.type = 'proxy_error';
    this.code = 'proxy_unavailable';
    this.proxyError = true;
  }
}

export function isProxyError(err) {
  return Boolean(err && (err.proxyError === true || err.code === 'proxy_unavailable'));
}

// One shape for every handler: no proxy URL, credential, or target ever appears.
export function proxyErrorPayload(message) {
  return {
    error: {
      message: message || 'Proxy egress is unavailable.',
      type: 'proxy_error',
      code: 'proxy_unavailable',
    },
  };
}

export function proxyErrorCode(err) {
  return err instanceof ProxyTransportError && /^(timeout|connect_failed|auth_failed|tunnel_refused|tls_failed)$/.test(err.code)
    ? err.code
    : 'connect_failed';
}

function targetHost(url) {
  return url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
}

function requestHeaders(input, body) {
  const source = input instanceof Headers
    ? [...input]
    : Array.isArray(input)
      ? input
      : Object.entries(input || {});
  const headers = {};
  for (const [name, value] of source) {
    const key = String(name).toLowerCase();
    if (HOP_BY_HOP.has(key) || key === 'host' || value === undefined) continue;
    headers[key] = Array.isArray(value) ? value.map(String) : String(value);
  }
  headers['accept-encoding'] = 'identity';
  if (body !== undefined && body !== null && headers['content-length'] === undefined
    && (typeof body === 'string' || Buffer.isBuffer(body) || ArrayBuffer.isView(body))) {
    headers['content-length'] = String(Buffer.byteLength(body));
  }
  return headers;
}

class TunnelAgent extends http.Agent {
  constructor(socket) {
    super({ keepAlive: false, maxSockets: 1 });
    this.tunnelSocket = socket;
  }

  createConnection() {
    return this.tunnelSocket;
  }
}

function responseHeaders(raw, decompressed) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    if (decompressed && (key === 'content-encoding' || key === 'content-length')) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(key, String(item));
    else if (value !== undefined) headers.set(key, String(value));
  }
  return headers;
}

function decoderFor(encoding) {
  const chain = String(encoding || '').toLowerCase().split(',').map((part) => part.trim()).filter(Boolean);
  if (!chain.length) return null;
  const decoders = [];
  for (const encodingName of chain.reverse()) {
    if (encodingName === 'gzip' || encodingName === 'x-gzip' || encodingName === 'deflate') decoders.push(zlib.createUnzip());
    else if (encodingName === 'br') decoders.push(zlib.createBrotliDecompress());
    else return null;
  }
  return decoders;
}

async function transportRequest(proxy, url, options) {
  const socket = await openTunnel(proxy, url, { signal: options.signal });
  try {
    const method = String(options.method || 'GET').toUpperCase();
    const body = options.body;
    const agent = new TunnelAgent(socket);
    const request = http.request({
      host: targetHost(url),
      port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
      path: `${url.pathname || '/'}${url.search || ''}`,
      method,
      headers: requestHeaders(options.headers, body),
      agent,
      signal: options.signal,
    });
    const response = await new Promise((resolve, reject) => {
      request.once('response', resolve);
      request.once('error', reject);
      if (body && typeof body.pipe === 'function') body.pipe(request);
      else request.end(body === null ? undefined : body);
      socket.resume();
    });
    const status = response.statusCode || 502;
    const noBody = method === 'HEAD' || status === 204 || status === 205 || status === 304;
    const decoders = noBody ? null : decoderFor(response.headers['content-encoding']);
    let stream = response;
    if (decoders) {
      for (const decoder of decoders) stream = stream.pipe(decoder);
    }
    const headers = responseHeaders(response.headers, Boolean(decoders));
    const init = {
      status,
      statusText: response.statusMessage || undefined,
      headers,
    };
    return new Response(noBody ? null : Readable.toWeb(stream), init);
  } catch (err) {
    socket.destroy();
    if (err.name === 'AbortError') throw err;
    if (err instanceof ProxyTransportError) throw err;
    throw new ProxyTransportError('connect_failed');
  }
}

// Same redirect and decompression contract as the direct `fetch` path, but the
// socket is opened through one selected proxy.
export async function proxyFetch(proxy, target, options = {}) {
  let url = target instanceof URL ? target : new URL(String(target));
  let method = String(options.method || 'GET').toUpperCase();
  let body = options.body;
  let headers = options.headers;
  let origin = url.origin;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProxyTransportError('connect_failed', 'Only HTTP(S) targets can use a proxy.');
  }

  for (let count = 0; ; count += 1) {
    const response = await transportRequest(proxy, url, { ...options, method, body, headers });
    const location = response.headers.get('location');
    if (!REDIRECTS.has(response.status) || !location || count >= MAX_REDIRECTS) return response;

    let next;
    try {
      next = new URL(location, url);
    } catch {
      return response;
    }
    if (next.protocol !== 'http:' && next.protocol !== 'https:') return response;
    const becomesGet = response.status === 303
      || ((response.status === 301 || response.status === 302) && method === 'POST');
    if (!becomesGet && !REPLAYABLE(body)) return response;
    try {
      await response.body?.cancel();
    } catch {
      // The redirect body is being discarded; a cancellation error changes nothing.
    }

    if (becomesGet) {
      method = 'GET';
      body = undefined;
      const copy = new Headers(headers);
      copy.delete('content-type');
      copy.delete('content-length');
      copy.delete('content-encoding');
      headers = copy;
    }
    if (next.origin !== origin) {
      const copy = new Headers(headers);
      copy.delete('authorization');
      copy.delete('cookie');
      headers = copy;
    }
    origin = next.origin;
    url = next;
  }
}

// Called by the data-plane handlers. With the proxy pool off or assigned direct
// this is exactly the global fetch; otherwise it selects a proxy, retries once
// on a distinct one after a transport failure, then falls back or fails strict.
export async function dataPlaneFetch(providerId, url, options = {}) {
  const selection = selectProxy(providerId);
  if (!selection.proxy) {
    if (selection.mode === 'direct' || !selection.unavailable) return fetch(url, options);
    noteFallbackDirect();
    if (getProxySettings().strict) throw new ProxyUnavailableError();
    return fetch(url, options);
  }

  const tried = [];
  let candidate = selection.proxy;
  const strict = getProxySettings().strict;
  for (let attempt = 0; attempt < 2 && candidate; attempt += 1) {
    try {
      const response = await proxyFetch(candidate, url, options);
      noteProxied();
      markProxySuccess(candidate.id);
      return response;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      const code = proxyErrorCode(err);
      noteProxyFailure(code);
      markProxyRequestFailure(candidate.id, code);
      tried.push(candidate.id);
      if (attempt === 0 && selection.mode === 'global') {
        candidate = selectProxy(providerId, tried).proxy;
        continue;
      }
      break;
    }
  }

  noteFallbackDirect();
  if (strict) throw new ProxyUnavailableError();
  return fetch(url, options);
}
