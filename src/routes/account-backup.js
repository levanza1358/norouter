import { readJson, sendError, sendJson } from '../lib/http.js';
import { exportAccounts, restoreAccounts } from '../lib/accounts.js';
import { providers } from '../providers/index.js';

function knownProviderIds() {
  return new Set(providers.map((provider) => provider.id));
}

export function handleAccountExport(req, res) {
  const payload = exportAccounts();
  const body = JSON.stringify(payload, null, 2);
  const date = new Date().toISOString().slice(0, 10);
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-disposition': `attachment; filename="norouter-accounts-${date}.json"`,
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

export async function handleAccountRestore(req, res) {
  let body;
  try {
    body = await readJson(req, 8 * 1024 * 1024);
  } catch (err) {
    return sendError(res, err.status || 400, err.message);
  }
  const result = restoreAccounts(body, knownProviderIds());
  if (result.error) return sendError(res, result.status || 400, result.error);
  return sendJson(res, 200, result);
}
