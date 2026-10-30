import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from '../config-root.js';

export const LOCAL_CONFIG_FILE = join(ROOT, 'config.local.json');

export function readLocalConfig() {
  if (!existsSync(LOCAL_CONFIG_FILE)) return {};
  try {
    const value = JSON.parse(readFileSync(LOCAL_CONFIG_FILE, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function writeLocalConfig(patch = {}) {
  const next = { ...readLocalConfig(), ...patch };
  writeFileSync(LOCAL_CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return next;
}

export function validPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}
