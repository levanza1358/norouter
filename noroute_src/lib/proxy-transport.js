import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns/promises';

import { parseProxyUrl } from './proxy-url.js';

const STAGE_TIMEOUT_MS = 10_000;
const MAX_CONNECT_HEADER = 16 * 1024;

export class ProxyTransportError extends Error {
  constructor(code, message = '') {
    super(message || code);
    this.name = 'ProxyTransportError';
    this.code = code;
    this.status = 502;
  }
}

function abortError() {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function cleanHost(host) {
  const value = String(host || '');
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

function isIp(host) {
  return net.isIP(cleanHost(host)) !== 0;
}

function targetParts(targetUrl) {
  const parsed = targetUrl instanceof URL ? targetUrl : new URL(String(targetUrl));
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ProxyTransportError('connect_failed', 'Only HTTP(S) targets can use a proxy.');
  }
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  const host = parsed.hostname;
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ProxyTransportError('connect_failed', 'Target host or port is invalid.');
  }
  return { protocol: parsed.protocol.slice(0, -1), host, hostname: cleanHost(host), port };
}

function authority(host, port) {
  const value = String(host);
  return `${value.includes(':') && !value.startsWith('[') ? `[${value}]` : value}:${port}`;
}

function connectErrorCode(err) {
  const code = String(err?.code || '');
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'timeout';
  if (code.startsWith('ERR_TLS_') || code.startsWith('CERT_') || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
    || code === 'SELF_SIGNED_CERT_IN_CHAIN' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
    return 'tls_failed';
  }
  return 'connect_failed';
}

function waitSocket(socket, event, { signal, timeoutMs = STAGE_TIMEOUT_MS, code = 'connect_failed' } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.off(event, onEvent);
      socket.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
      if (error) {
        if (error.code !== 'proxy_abort') socket.destroy();
        reject(error);
      } else {
        resolve();
      }
    };
    const onEvent = () => finish();
    const onError = (err) => finish(new ProxyTransportError(code === 'tls_failed' ? 'tls_failed' : connectErrorCode(err)));
    const onAbort = () => finish(abortError());
    const timer = setTimeout(() => {
      finish(new ProxyTransportError('timeout'));
    }, timeoutMs);
    socket.once(event, onEvent);
    socket.once('error', onError);
    if (signal) {
      if (signal.aborted) {
        finish(abortError());
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

async function tcpConnect(host, port, options) {
  const socket = net.connect({ host: cleanHost(host), port });
  socket.setNoDelay(true);
  // Keep a listener attached across handoff boundaries; individual waits add
  // and remove their own error handling.
  socket.on('error', () => {});
  await waitSocket(socket, 'connect', options);
  return socket;
}

function tlsServername(host, port) {
  if (isIp(host)) return undefined;
  return cleanHost(host);
}

async function tlsConnect(socket, host, port, options) {
  const servername = tlsServername(host, port);
  const secure = tls.connect({
    socket,
    servername,
    rejectUnauthorized: true,
    ...(isIp(host) ? { checkServerIdentity: (_name, cert) => tls.checkServerIdentity(cleanHost(host), cert) } : {}),
  });
  secure.on('error', () => {});
  try {
    await waitSocket(secure, 'secureConnect', { ...options, code: 'tls_failed' });
  } catch (err) {
    secure.destroy();
    if (err.name === 'AbortError') throw err;
    if (err.code === 'timeout') throw new ProxyTransportError('timeout');
    throw new ProxyTransportError('tls_failed');
  }
  return secure;
}

class SocketReader {
  constructor(socket) {
    this.socket = socket;
    this.chunks = [];
    this.length = 0;
    this.error = null;
    this.ended = false;
    this.waiters = [];
    this.onData = (chunk) => {
      this.chunks.push(chunk);
      this.length += chunk.length;
      this.flush();
    };
    this.onError = (err) => {
      this.error = err;
      this.flush();
    };
    this.onEnd = () => {
      this.ended = true;
      this.flush();
    };
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('end', this.onEnd);
    socket.on('close', this.onEnd);
  }

  flush() {
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  async more() {
    if (this.error) throw new ProxyTransportError(connectErrorCode(this.error));
    if (this.ended) throw new ProxyTransportError('connect_failed', 'Proxy closed the connection during the handshake.');
    await new Promise((resolve) => this.waiters.push(resolve));
    if (this.error) throw new ProxyTransportError(connectErrorCode(this.error));
  }

  buffer() {
    if (this.chunks.length === 1) return this.chunks[0];
    if (this.chunks.length > 1) {
      const combined = Buffer.concat(this.chunks);
      this.chunks = [combined];
      return combined;
    }
    return Buffer.alloc(0);
  }

  take(count) {
    const buffer = this.buffer();
    const out = buffer.subarray(0, count);
    const rest = buffer.subarray(count);
    this.chunks = rest.length ? [rest] : [];
    this.length = rest.length;
    return out;
  }

  async need(count) {
    while (this.length < count) await this.more();
    return this.take(count);
  }

  async until(marker, max = MAX_CONNECT_HEADER) {
    for (;;) {
      const buffer = this.buffer();
      const index = buffer.indexOf(marker);
      if (index >= 0) return this.take(index + marker.length);
      if (buffer.length > max) throw new ProxyTransportError('tunnel_refused', 'Proxy response headers are too large.');
      await this.more();
    }
  }

  detach() {
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onError);
    this.socket.off('end', this.onEnd);
    this.socket.off('close', this.onEnd);
    const rest = Buffer.concat(this.chunks);
    this.chunks = [];
    this.length = 0;
    this.socket.pause();
    return rest;
  }
}

function withReaderDeadline(socket, options, fn) {
  const signal = options.signal;
  let timedOut = false;
  let aborted = false;
  const timer = setTimeout(() => {
    timedOut = true;
    socket.destroy();
  }, options.timeoutMs || STAGE_TIMEOUT_MS);
  const onAbort = () => {
    aborted = true;
    socket.destroy();
  };
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      return Promise.reject(abortError());
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }
  return fn()
    .catch((err) => {
      if (aborted) throw abortError();
      if (timedOut) throw new ProxyTransportError('timeout');
      throw err;
    })
    .finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    });
}

function basicAuth(username, password) {
  if (!username && !password) return '';
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

async function httpTunnel(proxy, target, options) {
  let socket = await tcpConnect(proxy.host, proxy.port, options);
  try {
    if (proxy.protocol === 'https') socket = await tlsConnect(socket, proxy.host, proxy.port, options);
    const head = [`CONNECT ${authority(target.host, target.port)} HTTP/1.1`, `Host: ${authority(target.host, target.port)}`, 'Proxy-Connection: Keep-Alive'];
    const auth = basicAuth(proxy.username, proxy.password);
    if (auth) head.push(`Proxy-Authorization: ${auth}`);
    socket.write(`${head.join('\r\n')}\r\n\r\n`);
    const reader = new SocketReader(socket);
    const header = await withReaderDeadline(socket, options, () => reader.until(Buffer.from('\r\n\r\n')));
    const text = header.toString('latin1');
    const status = Number((text.match(/^HTTP\/1\.[01]\s+(\d{3})/i) || [])[1]);
    const rest = reader.detach();
    if (status === 407) throw new ProxyTransportError('auth_failed');
    if (!(status >= 200 && status < 300)) throw new ProxyTransportError('tunnel_refused');
    if (rest.length) socket.unshift(rest);
    return socket;
  } catch (err) {
    socket.destroy();
    throw err;
  }
}

function ipv4Bytes(host) {
  const parts = cleanHost(host).split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return Buffer.from(parts);
}

function ipv6Bytes(host) {
  let text = cleanHost(host).replace(/%.+$/, '');
  if (net.isIP(text) !== 6) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = [];
  const expand = (part) => {
    if (!part) return;
    if (part.includes('.')) {
      const bytes = ipv4Bytes(part);
      if (!bytes) throw new Error('bad ipv4');
      groups.push((bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]);
      return;
    }
    for (const group of part) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) throw new Error('bad ipv6');
      groups.push(parseInt(group, 16));
    }
  };
  try {
    expand(left.join(':'));
    const leftCount = groups.length;
    const rightGroups = [];
    for (const group of right) {
      if (group.includes('.')) {
        const bytes = ipv4Bytes(group);
        if (!bytes) return null;
        rightGroups.push((bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
        rightGroups.push(parseInt(group, 16));
      }
    }
    const filled = halves.length === 2 ? 8 - leftCount - rightGroups.length : 0;
    if (halves.length === 2 && filled < 1) return null;
    const all = [...groups.slice(0, leftCount), ...Array(filled).fill(0), ...rightGroups];
    if (all.length !== 8) return null;
    const bytes = Buffer.alloc(16);
    all.forEach((value, index) => bytes.writeUInt16BE(value, index * 2));
    return bytes;
  } catch {
    return null;
  }
}

async function socksAddress(host, protocol) {
  const raw = cleanHost(host);
  const version = net.isIP(raw);
  if (version === 4) return { atyp: 1, bytes: ipv4Bytes(raw), name: raw };
  if (version === 6) return { atyp: 4, bytes: ipv6Bytes(raw), name: raw };
  if (protocol === 'socks5h') {
    const bytes = Buffer.from(raw, 'utf8');
    if (!bytes.length || bytes.length > 255) throw new ProxyTransportError('connect_failed');
    // RFC 1928 domain fields carry a one-byte length before the name.
    return { atyp: 3, bytes: Buffer.concat([Buffer.from([bytes.length]), bytes]), name: raw };
  }
  let resolved;
  try {
    resolved = await dns.lookup(raw, { all: true });
  } catch {
    throw new ProxyTransportError('connect_failed');
  }
  // Most SOCKS5 proxies cannot reach IPv6 targets, while a dual-stack resolver
  // often returns AAAA first (Node's verbatim order). Prefer A, keep AAAA as
  // the fallback for IPv6-only names.
  const chosen = resolved.find((row) => row.family === 4) || resolved[0];
  if (!chosen) throw new ProxyTransportError('connect_failed');
  if (chosen.family === 6) return { atyp: 4, bytes: ipv6Bytes(chosen.address), name: raw };
  return { atyp: 1, bytes: ipv4Bytes(chosen.address), name: raw };
}

function socksReplyError(code) {
  // All nonzero replies mean the proxy could not open the target. The short
  // code set is intentionally small so a failure never leaks target details.
  return new ProxyTransportError('tunnel_refused', `Proxy refused the tunnel (${code}).`);
}

async function socks5Tunnel(proxy, target, options) {
  const socket = await tcpConnect(proxy.host, proxy.port, options);
  return withReaderDeadline(socket, options, async () => {
    const reader = new SocketReader(socket);
    try {
      const hasAuth = Boolean(proxy.username || proxy.password);
      socket.write(hasAuth ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0]));
      let reply = await reader.need(2);
      if (reply[0] !== 5) throw new ProxyTransportError('tunnel_refused', 'SOCKS5 proxy returned a bad greeting.');
      const method = reply[1];
      if (method === 0xff) throw new ProxyTransportError('auth_failed');
      if (method === 2) {
        if (!hasAuth) throw new ProxyTransportError('auth_failed');
        const username = Buffer.from(proxy.username, 'utf8');
        const password = Buffer.from(proxy.password, 'utf8');
        if (username.length > 255 || password.length > 255) throw new ProxyTransportError('auth_failed');
        socket.write(Buffer.concat([
          Buffer.from([1, username.length]), username,
          Buffer.from([password.length]), password,
        ]));
        reply = await reader.need(2);
        if (reply[0] !== 1 || reply[1] !== 0) throw new ProxyTransportError('auth_failed');
      } else if (method !== 0) {
        throw new ProxyTransportError('auth_failed');
      }

      const address = await socksAddress(target.host, proxy.protocol);
      if (!address.bytes) throw new ProxyTransportError('connect_failed');
      const port = Buffer.alloc(2);
      port.writeUInt16BE(target.port);
      socket.write(Buffer.concat([
        Buffer.from([5, 1, 0, address.atyp]),
        address.bytes,
        port,
      ]));
      reply = await reader.need(4);
      if (reply[0] !== 5) throw new ProxyTransportError('tunnel_refused', 'SOCKS5 proxy returned a bad reply.');
      if (reply[1] !== 0) throw socksReplyError(reply[1]);
      let addressLength = 0;
      if (reply[3] === 1) addressLength = 4;
      else if (reply[3] === 4) addressLength = 16;
      else if (reply[3] === 3) addressLength = (await reader.need(1))[0];
      else throw new ProxyTransportError('tunnel_refused', 'SOCKS5 proxy returned an unknown address type.');
      await reader.need(addressLength + 2);
      const rest = reader.detach();
      if (rest.length) socket.unshift(rest);
      return socket;
    } catch (err) {
      reader.detach();
      throw err;
    }
  }).catch((err) => {
    socket.destroy();
    throw err;
  });
}

async function socks4Tunnel(proxy, target, options) {
  const socket = await tcpConnect(proxy.host, proxy.port, options);
  return withReaderDeadline(socket, options, async () => {
    const reader = new SocketReader(socket);
    try {
      let ip;
      let tail;
      if (proxy.protocol === 'socks4a') {
        ip = Buffer.from([0, 0, 0, 1]);
        tail = Buffer.concat([Buffer.from(cleanHost(target.host), 'utf8'), Buffer.from([0])]);
      } else {
        const raw = cleanHost(target.host);
        if (net.isIP(raw) === 4) {
          ip = ipv4Bytes(raw);
        } else {
          let resolved;
          try {
            resolved = await dns.lookup(raw, { family: 4 });
          } catch {
            throw new ProxyTransportError('connect_failed');
          }
          ip = ipv4Bytes(resolved.address);
        }
        if (!ip) throw new ProxyTransportError('connect_failed', 'SOCKS4 can only reach IPv4 targets.');
        tail = Buffer.from([0]);
      }
      const port = Buffer.alloc(2);
      port.writeUInt16BE(target.port);
      const user = Buffer.from(proxy.username || '', 'utf8');
      socket.write(Buffer.concat([
        Buffer.from([4, 1]),
        port,
        ip,
        user,
        Buffer.from([0]),
        tail,
      ]));
      const reply = await reader.need(8);
      if (reply[0] !== 0 || reply[1] !== 0x5a) throw socksReplyError(reply[1]);
      const rest = reader.detach();
      if (rest.length) socket.unshift(rest);
      return socket;
    } catch (err) {
      reader.detach();
      throw err;
    }
  }).catch((err) => {
    socket.destroy();
    throw err;
  });
}

async function tunnelToProxy(proxy, target, options) {
  if (proxy.protocol === 'http' || proxy.protocol === 'https') return httpTunnel(proxy, target, options);
  if (proxy.protocol === 'socks5' || proxy.protocol === 'socks5h') return socks5Tunnel(proxy, target, options);
  if (proxy.protocol === 'socks4' || proxy.protocol === 'socks4a') return socks4Tunnel(proxy, target, options);
  throw new ProxyTransportError('connect_failed', 'Unsupported proxy protocol.');
}

function proxyEntry(proxy) {
  if (proxy && proxy.protocol && proxy.host && proxy.port && proxy.username !== undefined) return proxy;
  try {
    return parseProxyUrl(proxy.url);
  } catch {
    throw new ProxyTransportError('connect_failed', 'Stored proxy is invalid.');
  }
}

// Opens the target socket through the proxy. HTTP targets come back plain;
// HTTPS targets get an end-to-end TLS layer over the tunnel, with normal
// certificate verification and SNI for DNS names.
export async function openTunnel(proxyRow, targetUrl, options = {}) {
  const proxy = proxyEntry(proxyRow);
  const target = targetParts(targetUrl);
  const opts = { signal: options.signal, timeoutMs: options.timeoutMs || STAGE_TIMEOUT_MS };
  const tunnel = await tunnelToProxy(proxy, target, opts);
  if (target.protocol !== 'https') return tunnel;
  try {
    return await tlsConnect(tunnel, target.host, target.port, opts);
  } catch (err) {
    tunnel.destroy();
    throw err;
  }
}
