// Enabled/disabled switch per provider. Stored in the meta table so it covers
// shipped and custom providers alike, and survives a restart. A disabled
// provider keeps its configuration, accounts and models; it just stops being
// routable until it is switched back on.

import { getDb } from './db.js';

const CONFIG_KEY = 'provider_states';

function readStates() {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(CONFIG_KEY);
  if (!row) return {};
  try {
    const parsed = JSON.parse(row.value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Defaults to enabled: a provider that was never switched off is routable.
export function providerEnabled(id) {
  return readStates()[id] !== false;
}

export function setProviderEnabled(id, enabled) {
  const states = readStates();
  if (enabled) delete states[id];
  else states[id] = false;
  getDb()
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(CONFIG_KEY, JSON.stringify(states));
  return { provider: id, enabled };
}
