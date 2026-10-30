import { getDb, transaction } from './db.js';

export function codexActiveAccounts() {
  return getDb().prepare("SELECT * FROM accounts WHERE provider = 'codex' AND enabled = 1 ORDER BY created_at, rowid").all();
}

export function codexAccountFetchRows() {
  return getDb().prepare("SELECT id, label, plan, enabled, cooldown_until, last_error FROM accounts WHERE provider = 'codex' AND enabled = 1 ORDER BY created_at, rowid").all();
}

export function codexAccountModels(accountId) {
  return getDb().prepare('SELECT model FROM codex_account_models WHERE account_id = ? ORDER BY model').all(accountId).map((row) => row.model);
}

export function codexModelAccounts(model) {
  return getDb().prepare(`
    SELECT a.* FROM accounts a
    JOIN codex_account_models m ON m.account_id = a.id
    WHERE a.provider = 'codex' AND m.model = ?
    ORDER BY a.created_at, a.rowid
  `).all(model);
}

export function codexCatalog() {
  // A previous catalog importer could have copied dashboard custom IDs into
  // this table. They are local labels, not upstream models, so never expose an
  // overlapping custom ID as a fetched Codex model.
  return getDb().prepare(`
    SELECT DISTINCT m.model
      FROM codex_account_models m
      JOIN accounts a ON a.id = m.account_id
     WHERE a.provider = 'codex'
       AND a.enabled = 1
       AND NOT EXISTS (
         SELECT 1 FROM custom_models c
          WHERE c.provider = 'codex' AND c.model = m.model
       )
     ORDER BY m.model
  `).all().map((row) => row.model);
}

export function codexAccountIdByToken(token) {
  const row = getDb().prepare('SELECT id FROM accounts WHERE provider = \'codex\' AND access_token = ?').get(token);
  return row?.id || null;
}

export function codexAccountPlan(accountId) {
  return getDb().prepare('SELECT plan FROM accounts WHERE id = ? AND provider = \'codex\'').get(accountId)?.plan || 'unknown';
}

export function codexModelAccess(model) {
  return getDb().prepare(`
    SELECT m.model, m.plan, COUNT(*) AS account_count
      FROM codex_account_models m
      JOIN accounts a ON a.id = m.account_id
     WHERE a.provider = 'codex' AND a.enabled = 1 AND m.model = ?
     GROUP BY m.model, m.plan
  `).all(model);
}

export function codexModelPlans() {
  const order = { free: 0, plus: 1, pro: 2, unknown: 3 };
  const grouped = new Map();
  for (const row of getDb().prepare(`
    SELECT m.model, m.plan
      FROM codex_account_models m
      JOIN accounts a ON a.id = m.account_id
     WHERE a.provider = 'codex' AND a.enabled = 1
  `).all()) {
    if (!grouped.has(row.model)) grouped.set(row.model, new Set());
    grouped.get(row.model).add(row.plan || 'unknown');
  }
  return new Map([...grouped].map(([model, plans]) => [
    model,
    [...plans].sort((a, b) => (order[a] ?? 3) - (order[b] ?? 3)),
  ]));
}

export function saveCodexAccountCatalog(accountId, plan, models) {
  const cleanPlan = ['free', 'plus', 'pro'].includes(String(plan).toLowerCase()) ? String(plan).toLowerCase() : 'unknown';
  const now = Date.now();
  transaction((db) => {
    db.prepare('UPDATE accounts SET plan = ?, plan_updated_at = ?, updated_at = ? WHERE id = ?').run(cleanPlan, now, now, accountId);
    // Older versions incorrectly stored fetched Codex IDs as custom models.
    // A provider fetch is authoritative: promote overlapping IDs back to the
    // fetched catalog and remove the stale custom marker/state.
    const cleanModels = [...new Set(models.map((value) => String(value).trim()).filter(Boolean))];
    const removeCustom = db.prepare('DELETE FROM custom_models WHERE provider = ? AND model = ?');
    const removeState = db.prepare('DELETE FROM model_states WHERE provider = ? AND model = ?');
    for (const model of cleanModels) {
      removeCustom.run('codex', model);
      removeState.run('codex', model);
    }
    db.prepare('DELETE FROM codex_account_models WHERE account_id = ?').run(accountId);
    const insert = db.prepare('INSERT INTO codex_account_models (account_id, model, plan, updated_at) VALUES (?, ?, ?, ?)');
    for (const model of cleanModels) insert.run(accountId, model, cleanPlan, now);
  });
  return { plan: cleanPlan, models: codexAccountModels(accountId), updatedAt: now };
}
