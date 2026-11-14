import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from './config-root.js';
import { readLocalConfig, validHost, validPort } from './lib/local-config.js';

export { ROOT };

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(join(ROOT, '.env'));

const localConfig = readLocalConfig();
const configuredPort = validPort(localConfig.port)
  || validPort(process.env.PORT)
  || 5555;
const configuredHost = validHost(localConfig.host)
  || validHost(process.env.HOST)
  || '0.0.0.0';

export const config = {
  port: configuredPort,
  host: configuredHost,
  requireApiKey: process.env.REQUIRE_API_KEY === 'true',
  apiKey: process.env.ROUTER_API_KEY || '',
  logRequests: process.env.ENABLE_REQUEST_LOGS !== 'false',
  // Kept under five minutes: clients give up on a stream that stays silent that
  // long and retry, which would duplicate a turn the relay was still serving.
  timeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS || 240000),
  // SSE comment cadence while the upstream is still thinking. Comments are
  // ignored by SSE parsers, so they never disturb the event stream itself.
  heartbeatMs: Number(process.env.STREAM_HEARTBEAT_MS || 20000),
  // Total budget a combo may spend walking its whole list. Each step still gets
  // timeoutMs at most; this only stops a chain of slow targets from running
  // forever while the client is kept alive by heartbeats.
  chainTimeoutMs: Number(process.env.CHAIN_TIMEOUT_MS || 600000),
};
