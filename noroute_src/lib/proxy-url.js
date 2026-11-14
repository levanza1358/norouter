import { isIP } from 'node:net';

// Proxy URLs are user input, so parsing is deliberately strict: one canonical
// form in, one canonical form stored. The transport always reads credentials
// from the parsed fields, never by splitting the display string.
export const PROXY_PROTOCOLS = ['http', 'https', 'socks4', 'socks4a', 'socks5', 'socks5h'];
const PROTOCOLS = new Set(PROXY_PROTOCOLS);
const MAX_URL = 2048;

export class ProxyUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProxyUrlError';
    this.status = 400;
  }
}

function fail(message) {
  throw new ProxyUrlError(message);
}

function decodePart(value, label) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(value || ''));
  } catch {
    fail(`Proxy ${label} has invalid percent-encoding.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(decoded)) fail(`Proxy ${label} contains a control character.`);
  return decoded;
}

function encodePart(value) {
  return encodeURIComponent(String(value));
}

function hostForUrl(rawHost) {
  let host = String(rawHost || '').trim();
  if (!host) fail('Proxy host is required.');
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.includes(':')) {
    if (isIP(host) !== 6) fail('Bare IPv6 proxy hosts must be valid and bracketed in a URL.');
    return `[${host}]`;
  }
  if (isIP(host) === 6) return `[${host}]`;
  return host;
}

// WHATWG URL drops a scheme's default port (http:80, https:443), so a list
// that spells it out would look port-less. Read it back from the authority.
function explicitPort(text) {
  const authority = text.slice(text.indexOf('://') + 3).split(/[/?#]/, 1)[0];
  const hostPart = authority.slice(authority.lastIndexOf('@') + 1);
  const match = hostPart.match(/:(\d+)$/);
  return match ? Number(match[1]) : null;
}

function canonical(protocol, username, password, host, port) {
  let auth = '';
  if (username || password) {
    auth = username ? encodePart(username) : '';
    if (password) auth += `:${encodePart(password)}`;
    auth += '@';
  }
  return `${protocol}://${auth}${host}:${port}`;
}

// Parses and canonicalises one URL. `raw` may carry surrounding whitespace, but
// none inside; those would make copy/paste mistakes hard to see.
export function parseProxyUrl(raw) {
  let text = String(raw ?? '').trim();
  if (!text) fail('Proxy URL is required.');
  if (text.length > MAX_URL) fail('Proxy URL is too long.');
  if (/[\s`$]/.test(text) || /[\u0000-\u001f\u007f]/.test(text)) {
    fail('Proxy URL contains whitespace, a backtick, or "$".');
  }

  const scheme = text.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (!scheme) fail('Proxy URL must include a scheme.');
  const protocol = scheme[1].toLowerCase();
  if (!PROTOCOLS.has(protocol)) fail(`Unsupported proxy scheme "${protocol}".`);

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    fail('Proxy URL is invalid.');
  }
  if (parsed.protocol !== `${protocol}:`) fail('Proxy URL has an invalid scheme.');
  if (parsed.search || parsed.hash) fail('Proxy URL must not contain a query or fragment.');
  if (parsed.pathname && parsed.pathname !== '/') fail('Proxy URL must not contain a path.');

  const port = parsed.port ? Number(parsed.port) : explicitPort(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail('Proxy URL must include a port from 1 to 65535.');
  }

  const host = hostForUrl(parsed.hostname);
  const username = decodePart(parsed.username, 'username');
  const password = decodePart(parsed.password, 'password');
  if ((protocol === 'socks4' || protocol === 'socks4a') && password) {
    fail('SOCKS4 proxies accept a user ID, not a password.');
  }

  return {
    url: canonical(protocol, username, password, host, port),
    protocol,
    host,
    port,
    username,
    password,
    hasAuth: Boolean(username || password),
  };
}

// The dashboard also accepts separate fields. IPv6 is easier to type without
// brackets there; only the URL form requires them.
export function parseProxyFields(fields) {
  if (!fields || typeof fields !== 'object') fail('Proxy fields are required.');
  const protocol = String(fields.protocol || '').trim().toLowerCase();
  if (!PROTOCOLS.has(protocol)) fail(`Unsupported proxy scheme "${protocol || 'missing'}".`);
  const port = Number(fields.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('Proxy port must be an integer from 1 to 65535.');
  const host = hostForUrl(fields.host);
  const username = String(fields.username ?? '');
  const password = String(fields.password ?? '');
  if (protocol === 'socks4' || protocol === 'socks4a') {
    if (password) fail('SOCKS4 proxies accept a user ID, not a password.');
  }
  return parseProxyUrl(canonical(protocol, username, password, host, port));
}

export function maskProxyUrl(proxy) {
  if (!proxy) return '';
  const auth = proxy.hasAuth ? '•••@' : '';
  return `${proxy.protocol}://${auth}${proxy.host}:${proxy.port}`;
}

export function importCandidates(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  let values = null;
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) values = parsed.map((value) => String(value));
    } catch {
      // Fall through to line parsing; a malformed array then counts as one
      // invalid line per row instead of rejecting the whole paste silently.
    }
  }
  if (!values) values = text.split(/\r?\n/);
  return values
    .map((value) => value.trim())
    .filter((value) => value && !value.startsWith('#'));
}

export function parseProxyImport(raw) {
  const candidates = importCandidates(raw);
  const entries = [];
  const seen = new Set();
  let invalid = 0;
  let duplicates = 0;
  for (const candidate of candidates) {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) ? candidate : `http://${candidate}`;
    let entry;
    try {
      entry = parseProxyUrl(withScheme);
    } catch {
      invalid += 1;
      continue;
    }
    if (seen.has(entry.url)) {
      duplicates += 1;
      continue;
    }
    seen.add(entry.url);
    entries.push(entry);
  }
  return { entries, invalid, duplicates, total: candidates.length };
}

export function proxyLabel(value, proxy) {
  const label = String(value ?? '').trim().slice(0, 80);
  return label || `${proxy.host}:${proxy.port}`;
}

export function isProxyProtocol(value) {
  return PROTOCOLS.has(String(value || '').toLowerCase());
}
