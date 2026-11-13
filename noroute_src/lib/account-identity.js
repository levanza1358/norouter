import { getDb, transaction } from './db.js';
import { normalizePlan } from './plan.js';

// A token is not an account. OAuth providers rotate the refresh token on every
// login, so fingerprinting the secret alone lets the same Google or OpenAI
// account enter the pool again and again: the old row goes stale, the new one
// takes over, and the dashboard shows two accounts where there is one. The
// durable key is the identity the provider puts inside the login (Antigravity:
// the Google email; Codex: `chatgpt_account_id`), stored in `accounts.uid`.

function now() {
  return Date.now();
}

// Codex access and refresh tokens are JWTs. The CLI reads the account id and
// plan from the `https://api.openai.com/auth` claim, so a login can name its
// account without another API call, and an already-stored token can backfill
// rows that were saved before the uid was captured.
export function identityFromToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const auth = payload?.['https://api.openai.com/auth'];
  if (!auth || typeof auth !== 'object') return null;
  const uid = String(auth.chatgpt_account_id || payload.sub || '').trim();
  if (!uid) return null;
  return {
    uid,
    plan: normalizePlan(auth.chatgpt_plan_type),
    email: String(payload.email || '').trim(),
  };
}

// Existing Codex rows carry the JWT already; decoding it is enough to give them
// the identity (and plan) that new logins capture directly.
export function backfillAccountIdentity() {
  const db = getDb();
  const rows = db.prepare(
    "SELECT id, uid, plan, access_token, refresh_token FROM accounts WHERE provider = 'codex'",
  ).all();
  let updated = 0;

  transaction(() => {
    for (const row of rows) {
      const identity = identityFromToken(row.access_token) || identityFromToken(row.refresh_token);
      if (!identity) continue;

      const sets = [];
      const params = [];
      if (!row.uid) {
        sets.push('uid = ?');
        params.push(identity.uid);
      }
      if (normalizePlan(row.plan) === 'unknown' && identity.plan !== 'unknown') {
        sets.push('plan = ?', 'plan_updated_at = ?');
        params.push(identity.plan, now());
      }
      if (!sets.length) continue;

      sets.push('updated_at = ?');
      params.push(now(), row.id);
      db.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      updated += 1;
    }
  });

  return updated;
}

// The surviving row should be the one that can still serve requests: a refresh
// token first, then an enabled row, then a healthy one, then the most recently
// used. Row order is the final tie-break so the choice is stable.
function rowScore(row) {
  return [
    row.refresh_token ? 1 : 0,
    row.enabled ? 1 : 0,
    row.last_error ? 0 : 1,
    Number(row.last_used_at || 0),
    Number(row.updated_at || 0),
    Number(row.created_at || 0),
  ];
}

function preferredRow(rows) {
  return rows.slice().sort((a, b) => {
    const left = rowScore(a);
    const right = rowScore(b);
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return right[index] - left[index];
    }
    return String(a.id).localeCompare(String(b.id));
  })[0];
}

function mergeGroup(db, rows) {
  const keep = preferredRow(rows);
  const drop = rows.filter((row) => row.id !== keep.id);
  const ids = rows.map((row) => row.id);
  const marks = ids.map(() => '?').join(', ');

  // Usage history belongs to the account, not to the credential, so it is
  // summed onto the surviving row before the duplicates disappear.
  const usage = db.prepare(`
    SELECT day,
           SUM(requests) AS requests,
           SUM(tokens_in) AS tokens_in,
           SUM(tokens_out) AS tokens_out
      FROM account_usage
     WHERE account_id IN (${marks})
     GROUP BY day
  `).all(...ids);
  db.prepare(`DELETE FROM account_usage WHERE account_id IN (${marks})`).run(...ids);
  const insertUsage = db.prepare(`
    INSERT INTO account_usage (account_id, day, requests, tokens_in, tokens_out)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(account_id, day) DO UPDATE SET
      requests = excluded.requests,
      tokens_in = excluded.tokens_in,
      tokens_out = excluded.tokens_out
  `);
  for (const item of usage) {
    insertUsage.run(keep.id, item.day, item.requests, item.tokens_in, item.tokens_out);
  }

  // Model catalogs are per account too. Overlapping models keep the surviving
  // row's plan; only models it did not know are copied over.
  const copyModels = db.prepare(`
    INSERT OR IGNORE INTO codex_account_models (account_id, model, plan, updated_at)
    SELECT ?, model, plan, updated_at FROM codex_account_models WHERE account_id = ?
  `);
  for (const row of drop) copyModels.run(keep.id, row.id);

  const sums = rows.reduce((total, row) => ({
    requests: total.requests + Number(row.requests || 0),
    errors: total.errors + Number(row.errors || 0),
    tokensIn: total.tokensIn + Number(row.tokens_in || 0),
    tokensOut: total.tokensOut + Number(row.tokens_out || 0),
  }), { requests: 0, errors: 0, tokensIn: 0, tokensOut: 0 });
  const lastUsed = Math.max(...rows.map((row) => Number(row.last_used_at || 0)));
  const lastRefresh = Math.max(...rows.map((row) => Number(row.last_refresh_at || 0)));
  const createdAt = Math.min(...rows.map((row) => Number(row.created_at || now())));
  const withPlan = rows.find((row) => normalizePlan(row.plan) !== 'unknown');
  const plan = withPlan ? normalizePlan(withPlan.plan) : normalizePlan(keep.plan);

  db.prepare(`
    UPDATE accounts
       SET access_token = ?, refresh_token = ?, expires_at = ?, project_id = ?,
           plan = ?, plan_updated_at = ?, last_refresh_at = ?,
           requests = ?, errors = ?, tokens_in = ?, tokens_out = ?,
           last_used_at = ?, created_at = ?, updated_at = ?
     WHERE id = ?
  `).run(
    keep.access_token || drop.find((row) => row.access_token)?.access_token || '',
    keep.refresh_token || drop.find((row) => row.refresh_token)?.refresh_token || '',
    keep.expires_at ?? drop.find((row) => row.expires_at)?.expires_at ?? null,
    keep.project_id || drop.find((row) => row.project_id)?.project_id || '',
    plan,
    withPlan ? (withPlan.plan_updated_at ?? now()) : keep.plan_updated_at ?? null,
    lastRefresh || null,
    sums.requests,
    sums.errors,
    sums.tokensIn,
    sums.tokensOut,
    lastUsed || null,
    createdAt,
    now(),
    keep.id,
  );

  const remove = db.prepare('DELETE FROM accounts WHERE id = ?');
  for (const row of drop) remove.run(row.id);

  return drop.length;
}

// Merges rows that the same provider account produced under different tokens.
// Called once at startup, before the unique index is installed, so an older
// database converges to the same rule as a fresh one.
export function mergeDuplicateAccounts() {
  const db = getDb();
  const groups = db.prepare(`
    SELECT provider, uid
      FROM accounts
     WHERE uid <> ''
     GROUP BY provider, uid
    HAVING COUNT(*) > 1
  `).all();
  let merged = 0;

  transaction(() => {
    for (const group of groups) {
      const rows = db.prepare(
        'SELECT * FROM accounts WHERE provider = ? AND uid = ? ORDER BY created_at, rowid',
      ).all(group.provider, group.uid);
      if (rows.length > 1) merged += mergeGroup(db, rows);
    }
  });

  return merged;
}

// The database enforces "one account per provider identity" after the merge.
// Uid-less rows (API keys, hand-added tokens) are exempt: they have no identity
// to compare, and the fingerprint index already keeps their secrets unique.
export function ensureAccountIdentityIndex() {
  try {
    getDb().exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS accounts_identity ON accounts(provider, uid) WHERE uid <> ''",
    );
    return true;
  } catch {
    return false;
  }
}
