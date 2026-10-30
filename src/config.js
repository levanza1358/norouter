import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from './config-root.js';
import { readLocalConfig, validPort } from './lib/local-config.js';

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

export const config = {
  port: configuredPort,
  host: process.env.HOST || '127.0.0.1',
  requireApiKey: process.env.REQUIRE_API_KEY === 'true',
  apiKey: process.env.ROUTER_API_KEY || '',
  logRequests: process.env.ENABLE_REQUEST_LOGS !== 'false',
  timeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS || 300000),
};
