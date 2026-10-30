// Combos: named virtual models that try a list of real models in order.
//
// The combo name is checked before resolveModel(), never inside it: a name with
// a "/" is always a provider/model reference, so a combo can never shadow one.
// Array order in `models` is the priority order.

import { randomUUID } from 'node:crypto';

import { getDb } from './db.js';
import { resolveModel } from './model.js';

const NAME_MAX = 60;
// Plain name: no slash (that form belongs to provider/model), no whitespace, and
// a conservative character set so the id can be sent by any client verbatim.
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;

export function isComboName(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('/');
}

export function validateComboName(raw) {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) return { error: 'Combo name is required.' };
  if (name.length > NAME_MAX) return { error: `Combo name must be at most ${NAME_MAX} characters.` };
  if (name.includes('/')) return { error: 'Combo name cannot contain "/". Use a plain name, not provider/model.' };
  if (!NAME_PATTERN.test(name)) {
    return { error: 'Combo name must start with a letter or digit and use only letters, digits, ".", "_" or "-".' };
  }
  return { name };
}

// Every entry must resolve through the normal resolver, so a combo can never be
// saved with a model id that the router would reject later.
export function validateComboModels(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'Combo must list at least one model.' };
  }
  const models = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry.trim()) {
      return { error: 'Each combo model must be a non-empty string.' };
    }
    const value = entry.trim();
    const resolved = resolveModel(value);
    if (resolved.error) return { error: `${value}: ${resolved.error}` };
    // The array is the operator's explicit priority list, so it is stored
    // exactly as entered; filtering entries here would silently change it.
    models.push(value);
  }
  if (!models.length) return { error: 'Combo must list at least one model.' };
  return { models };
}

function parseModels(text) {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((value) => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function publicCombo(row) {
  return {
    id: row.id,
    name: row.name,
    models: parseModels(row.models),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listCombos() {
  return getDb()
    .prepare('SELECT * FROM combos ORDER BY name COLLATE NOCASE')
    .all()
    .map(publicCombo);
}

function rowByName(name) {
  return getDb().prepare('SELECT * FROM combos WHERE name = ?').get(name);
}

function rowById(id) {
  return getDb().prepare('SELECT * FROM combos WHERE id = ?').get(id);
}

// Resolves a request model name to its ordered list of real models, or null when
// the name is not a combo. Names containing "/" are never combos.
export function comboModels(name) {
  if (!isComboName(name)) return null;
  const row = rowByName(String(name).trim());
  if (!row) return null;
  const models = parseModels(row.models);
  return models.length ? models : null;
}

export function getCombo(id) {
  const row = rowById(id);
  return row ? publicCombo(row) : null;
}

export function createCombo(input = {}) {
  const name = validateComboName(input.name);
  if (name.error) return { status: 400, error: name.error };
  const models = validateComboModels(input.models);
  if (models.error) return { status: 400, error: models.error };
  if (rowByName(name.name)) return { status: 409, error: `A combo named "${name.name}" already exists.` };

  const now = Date.now();
  const row = {
    id: randomUUID(),
    name: name.name,
    models: JSON.stringify(models.models),
    created_at: now,
    updated_at: now,
  };
  try {
    getDb()
      .prepare('INSERT INTO combos (id, name, models, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(row.id, row.name, row.models, row.created_at, row.updated_at);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.errcode === 2067) {
      return { status: 409, error: `A combo named "${name.name}" already exists.` };
    }
    throw err;
  }
  return { combo: publicCombo(row) };
}

export function updateCombo(id, patch = {}) {
  const current = rowById(id);
  if (!current) return { status: 404, error: `Unknown combo "${id}".` };

  let name = current.name;
  if (patch.name !== undefined) {
    const checked = validateComboName(patch.name);
    if (checked.error) return { status: 400, error: checked.error };
    const clash = rowByName(checked.name);
    if (clash && clash.id !== id) return { status: 409, error: `A combo named "${checked.name}" already exists.` };
    name = checked.name;
  }

  let models = parseModels(current.models);
  if (patch.models !== undefined) {
    const checked = validateComboModels(patch.models);
    if (checked.error) return { status: 400, error: checked.error };
    models = checked.models;
  }

  const now = Date.now();
  try {
    getDb()
      .prepare('UPDATE combos SET name = ?, models = ?, updated_at = ? WHERE id = ?')
      .run(name, JSON.stringify(models), now, id);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.errcode === 2067) {
      return { status: 409, error: `A combo named "${name}" already exists.` };
    }
    throw err;
  }
  return { combo: publicCombo(rowById(id)) };
}

export function deleteCombo(id) {
  const row = rowById(id);
  if (!row) return { status: 404, error: `Unknown combo "${id}".` };
  getDb().prepare('DELETE FROM combos WHERE id = ?').run(id);
  return { combo: publicCombo(row) };
}
