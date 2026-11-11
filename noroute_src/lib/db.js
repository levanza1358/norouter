import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from '../config.js';

// One SQLite file holds accounts, custom providers and custom models. Accounts
// are the only table with a write rate, so the pool keeps its hot counters in
// memory and flushes them in batches (see accounts.js).
const DIR = join(ROOT, 'data');
mkdirSync(DIR, { recursive: true });

export const DB_FILE = process.env.NOROUTER_DB
  ? process.env.NOROUTER_DB
  : join(DIR, 'norouter.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,
  label         TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'access_token',
  access_token  TEXT NOT NULL DEFAULT '',
  refresh_token TEXT NOT NULL DEFAULT '',
  uid           TEXT NOT NULL DEFAULT '',
  fingerprint   TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  expires_at    INTEGER,
  cooldown_until INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT NOT NULL DEFAULT '',
  last_used_at  INTEGER,
  requests      INTEGER NOT NULL DEFAULT 0,
  errors        INTEGER NOT NULL DEFAULT 0,
  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_refresh_at INTEGER,
  plan          TEXT NOT NULL DEFAULT 'unknown',
  plan_updated_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS accounts_fingerprint
  ON accounts(provider, fingerprint);
CREATE INDEX IF NOT EXISTS accounts_provider
  ON accounts(provider, label);

CREATE TABLE IF NOT EXISTS codex_account_models (
  account_id TEXT NOT NULL,
  model      TEXT NOT NULL,
  plan       TEXT NOT NULL DEFAULT 'unknown',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, model),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS codex_account_models_model ON codex_account_models(model);

CREATE TABLE IF NOT EXISTS custom_models (
  provider   TEXT NOT NULL,
  model      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, model)
);

CREATE TABLE IF NOT EXISTS model_states (
  provider   TEXT NOT NULL,
  model      TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, model)
);

CREATE TABLE IF NOT EXISTS custom_providers (
  id         TEXT PRIMARY KEY,
  source_id  TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  website    TEXT NOT NULL DEFAULT '',
  base_url   TEXT NOT NULL,
  chat_path  TEXT NOT NULL DEFAULT '/chat/completions',
  token_env  TEXT NOT NULL DEFAULT '',
  prefix     TEXT NOT NULL DEFAULT '',
  aliases    TEXT NOT NULL DEFAULT '[]',
  headers    TEXT NOT NULL DEFAULT '{}',
  models     TEXT NOT NULL DEFAULT '[]',
  config     TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_overrides (
  source_id  TEXT PRIMARY KEY,
  id         TEXT NOT NULL,
  prefix     TEXT NOT NULL DEFAULT '',
  aliases    TEXT NOT NULL,
  name       TEXT NOT NULL,
  website    TEXT NOT NULL DEFAULT '',
  base_url   TEXT NOT NULL,
  chat_path  TEXT NOT NULL,
  headers    TEXT NOT NULL,
  models     TEXT NOT NULL,
  config     TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS account_usage (
  account_id TEXT NOT NULL,
  day        TEXT NOT NULL,
  requests   INTEGER NOT NULL DEFAULT 0,
  tokens_in  INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, day)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  key_hash      TEXT NOT NULL UNIQUE,
  key_prefix    TEXT NOT NULL,
  secret        TEXT UNIQUE,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  expires_at    INTEGER,
  request_limit INTEGER,
  token_limit   INTEGER
);

CREATE TABLE IF NOT EXISTS api_key_usage (
  key_id     TEXT NOT NULL,
  day        TEXT NOT NULL,
  requests   INTEGER NOT NULL DEFAULT 0,
  tokens_in  INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, day)
);
CREATE INDEX IF NOT EXISTS api_key_usage_day ON api_key_usage(key_id, day);

-- Global usage survives a restart. Rows are bucketed per local hour, so the
-- daily/weekly/monthly/all-time reports are plain SUM() rollups. account_usage
-- stays per account and keeps its UTC day key; this table is the dashboard's.
CREATE TABLE IF NOT EXISTS usage_hourly (
  bucket        TEXT NOT NULL,
  provider      TEXT NOT NULL DEFAULT '',
  model         TEXT NOT NULL DEFAULT '',
  requests      INTEGER NOT NULL DEFAULT 0,
  errors        INTEGER NOT NULL DEFAULT 0,
  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,
  latency_ms    INTEGER NOT NULL DEFAULT 0,
  latency_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, provider, model)
);
CREATE INDEX IF NOT EXISTS usage_hourly_bucket ON usage_hourly(bucket);

-- Per-request activity for the Usage page. Store only public account labels and
-- request metrics; credentials and request bodies never enter this table.
CREATE TABLE IF NOT EXISTS usage_activity (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           INTEGER NOT NULL,
  provider     TEXT NOT NULL DEFAULT '',
  model        TEXT NOT NULL DEFAULT '',
  account      TEXT NOT NULL DEFAULT '',
  tokens_in    INTEGER NOT NULL DEFAULT 0,
  tokens_out   INTEGER NOT NULL DEFAULT 0,
  latency_ms   INTEGER,
  status       INTEGER,
  ok           INTEGER NOT NULL DEFAULT 1,
  error        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS usage_activity_at ON usage_activity(at DESC);

-- A combo is a named virtual model: an ordered list of real model ids tried in
-- turn. Array order IS the priority, so there is no extra sort column.
CREATE TABLE IF NOT EXISTS combos (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  models     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT 'New chat',
  model      TEXT NOT NULL DEFAULT '',
  archived   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_sessions_updated ON chat_sessions(archived, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  reasoning  TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'complete',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE,
  UNIQUE(session_id, seq)
);
CREATE INDEX IF NOT EXISTS chat_messages_session ON chat_messages(session_id, seq);
`;

let db = null;

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Older builds kept providers and models in JSON files. Move them into SQLite
// once, then park the old file as .migrated so a downgrade still has the data.
function importLegacy(handle) {
  const modelsFile = join(DIR, 'custom-models.json');
  const providersFile = join(DIR, 'custom-providers.json');
  const models = readJson(modelsFile, null);
  const providers = readJson(providersFile, null);

  if (models && typeof models === 'object' && !Array.isArray(models)) {
    const insert = handle.prepare(
      'INSERT OR IGNORE INTO custom_models (provider, model, created_at) VALUES (?, ?, ?)',
    );
    handle.exec('BEGIN');
    try {
      for (const [provider, list] of Object.entries(models)) {
        if (!Array.isArray(list)) continue;
        for (const model of list) insert.run(provider, String(model), Date.now());
      }
      handle.exec('COMMIT');
    } catch (err) {
      handle.exec('ROLLBACK');
      throw err;
    }
    renameSync(modelsFile, `${modelsFile}.migrated`);
  }

  if (Array.isArray(providers)) {
    const insert = handle.prepare(
      'INSERT OR IGNORE INTO custom_providers (id, source_id, name, website, base_url, chat_path, token_env, prefix, aliases, headers, models, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    handle.exec('BEGIN');
    try {
      for (const entry of providers) {
        if (!entry || typeof entry.id !== 'string') continue;
        insert.run(
          entry.id,
          entry.id,
          String(entry.name || entry.id),
          String(entry.website || ''),
          String(entry.baseUrl || ''),
          String(entry.chatPath || '/chat/completions'),
          String(entry.tokenEnv || ''),
          String(entry.prefix || (Array.isArray(entry.aliases) && entry.aliases[0]) || entry.id),
          '[]',
          JSON.stringify(entry.headers && typeof entry.headers === 'object' ? entry.headers : {}),
          JSON.stringify(Array.isArray(entry.models) ? entry.models : []),
          Date.now(),
        );
      }
      handle.exec('COMMIT');
    } catch (err) {
      handle.exec('ROLLBACK');
      throw err;
    }
    renameSync(providersFile, `${providersFile}.migrated`);
  }
}

export function getDb() {
  if (db) return db;

  db = new DatabaseSync(DB_FILE);
  // WAL keeps dashboard reads from blocking a streaming request's writes, and
  // NORMAL sync is the usual safe/fast trade-off for a local file.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  const columns = new Set(db.prepare('PRAGMA table_info(api_keys)').all().map((column) => column.name));
  for (const [name, type] of [['expires_at', 'INTEGER'], ['request_limit', 'INTEGER'], ['token_limit', 'INTEGER'], ['secret', 'TEXT']]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE api_keys ADD COLUMN ${name} ${type}`);
  }
  const accountColumns = new Set(db.prepare('PRAGMA table_info(accounts)').all().map((column) => column.name));
  if (!accountColumns.has('last_refresh_at')) db.exec('ALTER TABLE accounts ADD COLUMN last_refresh_at INTEGER');
  if (!accountColumns.has('plan')) db.exec("ALTER TABLE accounts ADD COLUMN plan TEXT NOT NULL DEFAULT 'unknown'");
  if (!accountColumns.has('plan_updated_at')) db.exec('ALTER TABLE accounts ADD COLUMN plan_updated_at INTEGER');
  const chatMessageColumns = new Set(db.prepare('PRAGMA table_info(chat_messages)').all().map((column) => column.name));
  if (!chatMessageColumns.has('reasoning')) db.exec("ALTER TABLE chat_messages ADD COLUMN reasoning TEXT NOT NULL DEFAULT ''");
  const providerColumns = new Set(db.prepare('PRAGMA table_info(custom_providers)').all().map((column) => column.name));
  for (const [name, type] of [['source_id', 'TEXT'], ['prefix', "TEXT NOT NULL DEFAULT ''"], ['aliases', "TEXT NOT NULL DEFAULT '[]'"], ['headers', "TEXT NOT NULL DEFAULT '{}' "], ['config', "TEXT NOT NULL DEFAULT '{}' "]]) {
    if (!providerColumns.has(name)) db.exec(`ALTER TABLE custom_providers ADD COLUMN ${name} ${type}`);
  }
  const overrideColumns = new Set(db.prepare('PRAGMA table_info(provider_overrides)').all().map((column) => column.name));
  if (!overrideColumns.has('prefix')) db.exec("ALTER TABLE provider_overrides ADD COLUMN prefix TEXT NOT NULL DEFAULT ''");
  if (!overrideColumns.has('config')) db.exec("ALTER TABLE provider_overrides ADD COLUMN config TEXT NOT NULL DEFAULT '{}'");
  db.exec("UPDATE custom_providers SET source_id = id WHERE source_id IS NULL OR source_id = ''");
  db.exec("UPDATE custom_providers SET prefix = COALESCE(NULLIF(prefix, ''), json_extract(aliases, '$[0]'), id) WHERE prefix IS NULL OR prefix = ''");
  db.exec("UPDATE provider_overrides SET prefix = COALESCE(NULLIF(prefix, ''), json_extract(aliases, '$[0]'), id) WHERE prefix IS NULL OR prefix = ''");
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS custom_providers_source_id ON custom_providers(source_id)');

  const version = db.prepare("SELECT value FROM meta WHERE key = 'schema'").get();
  if (!version) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema', '1')").run();
  }

  importLegacy(db);
  return db;
}

// Runs fn inside one transaction. Used by bulk import so 1,000 accounts land as
// a single fsync instead of 1,000.
export function transaction(fn) {
  const handle = getDb();
  handle.exec('BEGIN');
  try {
    const result = fn(handle);
    handle.exec('COMMIT');
    return result;
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }
}

export function closeDb() {
  if (!db) return;
  db.close();
  db = null;
}
