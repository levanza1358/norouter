import net from 'node:net';

import { sendError, sendJson } from '../lib/http.js';
import { validPort } from '../lib/local-config.js';

function canBind(host, port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    const done = (available) => {
      probe.removeAllListeners();
      probe.close(() => resolve(available));
    };
    probe.once('error', () => done(false));
    probe.listen({ host, port }, () => done(true));
  });
}

export function handlePortGet(req, res, settings) {
  return sendJson(res, 200, { host: settings.host, port: settings.port });
}

export async function handlePortUpdate(req, res, settings, readJson, rebind) {
  let body;
  try { body = await readJson(req, 16 * 1024); } catch (err) { return sendError(res, err.status || 400, err.message); }
  const port = validPort(body?.port);
  if (!port) return sendError(res, 400, 'port must be an integer between 1 and 65535.');
  if (port === settings.port) return sendJson(res, 200, { host: settings.host, port, changed: false });
  if (!(await canBind(settings.host, port))) return sendError(res, 409, `Port ${port} is already in use.`);
  sendJson(res, 200, { host: settings.host, port, changed: true });
  setImmediate(() => rebind(port).catch(() => {}));
}
