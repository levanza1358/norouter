import { readJson, sendError, sendJson } from '../lib/http.js';
import {
  importCandidates,
  parseProxyFields,
  parseProxyImport,
  parseProxyUrl,
  ProxyUrlError,
} from '../lib/proxy-url.js';
import {
  deleteProxy,
  getProxyRow,
  importProxyEntries,
  insertProxy,
  proxySnapshot,
  publicProxy,
  setProxyAssignment,
  updateProxy,
  updateProxySettings,
  validateProxySettingsPatch,
} from '../lib/proxies.js';
import { startProxyTestJob, testAndRecord } from '../lib/proxy-test.js';
import { SCRAPE_SOURCES, startScrapeJob } from '../lib/proxy-scrape.js';

async function bodyOf(req, res, limit = 64 * 1024) {
  try {
    return await readJson(req, limit);
  } catch (err) {
    sendError(res, err.status || 400, err.message);
    return null;
  }
}

function busy(res, kind, snapshot) {
  return sendJson(res, 409, {
    error: {
      message: kind === 'test' ? 'A proxy test is already running.' : 'A proxy scrape is already running.',
      type: 'invalid_request_error',
    },
    [kind === 'test' ? 'testing' : 'scrape']: snapshot,
  });
}

export function handleGetProxy(req, res) {
  return sendJson(res, 200, proxySnapshot());
}

export async function handleUpdateProxySettings(req, res) {
  const body = await bodyOf(req, res, 16 * 1024);
  if (body === null) return undefined;
  const error = validateProxySettingsPatch(body);
  if (error) return sendError(res, 400, error);
  return sendJson(res, 200, { settings: updateProxySettings(body) });
}

export async function handleCreateProxy(req, res) {
  const body = await bodyOf(req, res);
  if (body === null) return undefined;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return sendError(res, 400, 'Proxy fields are required.');
  }
  if ('test' in body && typeof body.test !== 'boolean') return sendError(res, 400, 'test must be a boolean.');
  if ('label' in body && typeof body.label !== 'string') return sendError(res, 400, 'label must be a string.');

  let entry;
  try {
    entry = typeof body.url === 'string' ? parseProxyUrl(body.url) : parseProxyFields(body);
  } catch (err) {
    if (err instanceof ProxyUrlError || err?.status === 400) return sendError(res, 400, err.message);
    throw err;
  }

  const inserted = insertProxy(entry, { source: 'manual', label: body.label || '' });
  if (inserted.duplicate) {
    return sendError(
      res,
      409,
      `Proxy ${publicProxy(inserted.duplicate).maskedUrl} already exists (${inserted.duplicate.id}).`,
    );
  }

  const test = body.test === false ? null : await testAndRecord(inserted.proxy);
  return sendJson(res, 201, { proxy: publicProxy(getProxyRow(inserted.proxy.id)), test });
}

export async function handleUpdateProxy(req, res, id) {
  const body = await bodyOf(req, res);
  if (body === null) return undefined;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return sendError(res, 400, 'Only enabled and label can be updated.');
  }
  const keys = Object.keys(body);
  if (keys.some((key) => key !== 'enabled' && key !== 'label')) {
    return sendError(res, 400, 'Only enabled and label can be updated.');
  }
  if ('enabled' in body && typeof body.enabled !== 'boolean') {
    return sendError(res, 400, 'enabled must be a boolean.');
  }
  if ('label' in body && typeof body.label !== 'string') {
    return sendError(res, 400, 'label must be a string.');
  }
  const updated = updateProxy(id, body);
  if (!updated) return sendError(res, 404, 'Proxy not found.');
  return sendJson(res, 200, { proxy: publicProxy(updated) });
}

export function handleDeleteProxy(req, res, id) {
  if (!deleteProxy(id)) return sendError(res, 404, 'Proxy not found.');
  return sendJson(res, 200, { deleted: true, id });
}

export async function handleTestProxy(req, res, id) {
  const row = getProxyRow(id);
  if (!row) return sendError(res, 404, 'Proxy not found.');
  return sendJson(res, 200, await testAndRecord(row));
}

export async function handleTestAllProxies(req, res) {
  const body = await bodyOf(req, res);
  if (body === null) return undefined;
  if (body && typeof body !== 'object') return sendError(res, 400, 'Body must be a JSON object.');
  let ids = null;
  if (body?.ids !== undefined) {
    if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== 'string')) {
      return sendError(res, 400, 'ids must be an array of proxy IDs.');
    }
    ids = body.ids;
    if (ids.some((id) => !getProxyRow(id))) return sendError(res, 400, 'Unknown proxy ID.');
  }
  const result = startProxyTestJob(ids);
  if (result.status === 409) return busy(res, 'test', result.testing);
  return sendJson(res, 202, { testing: result.testing });
}

export async function handleImportProxies(req, res) {
  const body = await bodyOf(req, res);
  if (body === null) return undefined;
  let raw;
  if (Array.isArray(body?.urls)) raw = body.urls.map((url) => String(url)).join('\n');
  else if (typeof body?.text === 'string') raw = body.text;
  else return sendError(res, 400, 'Provide text or a urls array.');

  if (importCandidates(raw).length > 1000) {
    return sendError(res, 400, 'At most 1000 candidates per import.');
  }
  const parsed = parseProxyImport(raw);
  const added = importProxyEntries(parsed.entries);
  return sendJson(res, 201, {
    added,
    duplicates: parsed.duplicates + (parsed.entries.length - added),
    invalid: parsed.invalid,
    total: parsed.total,
  });
}

export async function handleProxyAssignment(req, res, providerId) {
  const body = await bodyOf(req, res, 16 * 1024);
  if (body === null) return undefined;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return sendError(res, 400, 'Assignment must be a JSON object.');
  }
  const result = setProxyAssignment(providerId, body.mode, body.proxyId);
  if (result.error) return sendError(res, result.status || 400, result.error);
  return sendJson(res, 200, { assignments: result.assignments });
}

export async function handleScrapeProxies(req, res) {
  const body = await bodyOf(req, res, 16 * 1024);
  if (body === null) return undefined;
  if (body && typeof body !== 'object') return sendError(res, 400, 'Body must be a JSON object.');
  let sources;
  if (body?.sources !== undefined) {
    if (!Array.isArray(body.sources) || body.sources.some((source) => typeof source !== 'string')) {
      return sendError(res, 400, 'sources must be an array of source IDs.');
    }
    if (body.sources.some((source) => !SCRAPE_SOURCES.includes(source))) {
      return sendError(res, 400, 'Unknown scrape source.');
    }
    sources = body.sources;
  }
  if (body?.limit !== undefined && (!Number.isInteger(body.limit) || body.limit < 10 || body.limit > 1000)) {
    return sendError(res, 400, 'limit must be an integer from 10 to 1000.');
  }
  const result = startScrapeJob({ sources, limit: body?.limit });
  if (result.status === 409) return busy(res, 'scrape', result.scrape);
  return sendJson(res, 202, { scrape: result.scrape });
}
