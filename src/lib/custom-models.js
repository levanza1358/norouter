import { getDb } from './db.js';

// Model ids added from the dashboard live in SQLite next to the accounts, so a
// restart keeps them and the provider pages can page through a large catalog.

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,119}$/;

export function customModels(providerId) {
  return getDb()
    .prepare('SELECT model FROM custom_models WHERE provider = ? ORDER BY created_at, rowid')
    .all(providerId)
    .map((row) => row.model);
}

export function modelEnabled(providerId, model) {
  const row = getDb().prepare(
    'SELECT enabled FROM model_states WHERE provider = ? AND model = ?',
  ).get(providerId, model);
  return row ? Boolean(row.enabled) : true;
}

export function setModelEnabled(providerId, model, enabled) {
  getDb().prepare(`
    INSERT INTO model_states (provider, model, enabled, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(provider, model) DO UPDATE SET
      enabled = excluded.enabled, updated_at = excluded.updated_at
  `).run(providerId, model, enabled ? 1 : 0, Date.now());
  return { model, enabled: Boolean(enabled) };
}

export function deleteModelState(providerId, model) {
  getDb().prepare('DELETE FROM model_states WHERE provider = ? AND model = ?').run(providerId, model);
}

// Returns { model } on success, { error, status } otherwise.
export function addCustomModel(providerId, raw) {
  const model = typeof raw === 'string' ? raw.trim() : '';
  if (!MODEL_ID.test(model)) {
    return {
      status: 400,
      error: 'Model id must be 1-120 characters of letters, digits, dot, dash, underscore, colon, slash or plus.',
    };
  }

  const db = getDb();
  const exists = db
    .prepare('SELECT 1 AS hit FROM custom_models WHERE provider = ? AND model = ?')
    .get(providerId, model);
  if (exists) return { status: 409, error: `"${model}" is already a custom model` };

  db.prepare(
    'INSERT INTO custom_models (provider, model, created_at) VALUES (?, ?, ?)',
  ).run(providerId, model, Date.now());
  return { model };
}

export function removeCustomModel(providerId, model) {
  const result = getDb()
    .prepare('DELETE FROM custom_models WHERE provider = ? AND model = ?')
    .run(providerId, model);
  deleteModelState(providerId, model);
  return Number(result.changes) > 0;
}
