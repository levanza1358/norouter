# Data model

## SQLite file

Default: `data/norouter.db`. Override: `NOROUTER_DB`.

SQLite configuration:

```text
journal_mode = WAL
synchronous = NORMAL
busy_timeout = 5000ms
```

WAL and SHM sidecars are part of the database state and may contain sensitive data.

## Tables

### `meta`

Schema metadata. Current schema marker is `1`.

The `meta` key/value table also holds JSON settings that do not need their own table: `budgets` (API key/provider daily limits), `budget_alerts` (one alert marker per scope per day), `budget_pruned` (last retention pass day), `maintenance` (scheduler enabled/interval), `maintenance.state` (last run per maintenance task), `proxy_settings` (master switch, strategy, strict, auto-bench, scrape schedule), `proxy_assignments` (per-provider `global`/`direct`/`pinned`), and `proxy_state` (last completed scrape time).

### `accounts`

Stores provider ID, label, kind, access token, refresh token, durable account UID, SHA-256 fingerprint, enabled flag, expiry/cooldown, last error/use, counters, subscription plan, and timestamps.

`uid` is the identity the provider puts inside the login: Codex stores the `chatgpt_account_id` claim from its access/id JWT, Antigravity stores the Google email. It is the durable key for "one login, one account" — OAuth re-login rotates the token (and therefore the fingerprint) but not the UID.

Antigravity accounts also store `project_id`, the Cloud Code project returned by `loadCodeAssist`/`onboardUser` during login. It is nullable, set by Google OAuth rather than by the client, and used as the `project` field of the chat envelope.

`plan` is the normalized subscription tier: `free`, `plus`, `pro`, `ultra`, `team`, `business`, `enterprise`, or `unknown`. `plan_updated_at` records when the tier was last confirmed. Codex fills it from the JWT claim and from `/models`/quota reads, Antigravity from the Google One plan in `loadCodeAssist.paidTier` and quota reads. `unknown` means it has not been read yet; the dashboard hides the badge rather than guessing.

Important: credential columns are plaintext values in the local SQLite file. Protect the file with OS permissions, backups, and disk encryption.

Unique indexes:

- `(provider, fingerprint)` keeps one row per stored secret.
- `(provider, uid) WHERE uid <> ''` keeps one row per provider account. UID-less rows (hand-added API keys, plain tokens) are exempt because they carry no identity to compare.

Fingerprint input:

```text
SHA-256(`${kind}:${secret}`)
```

The fingerprint is never returned to the API/UI.

At startup, before the identity index is installed, the server decodes stored Codex JWTs to backfill `uid` and `plan`, merges rows that share `(provider, uid)` into the row that can still serve (preferring a refresh token, then an enabled/healthy/recently used row) while summing usage counters and copying model catalogs, and only then creates the index. Import-time checks remain as a fallback if the index cannot be installed.

### `proxies`

Operator-managed proxy pool for data-plane egress. Columns: `id` (primary key), `url` (unique, canonical, **includes credentials**), `label`, `source` (`manual`, `import`, `scrape`), `protocol`, `host`, `port`, `enabled`, `status` (`unchecked`, `ok`, `fail`), `latency_ms`, `fail_count`, `last_checked`, `last_error`, `created_at`, and `updated_at`.

The row is the connection target; the API only ever exposes a masked URL (`scheme://•••@host:port` when credentials exist). URLs are immutable after insert, and a duplicate canonical URL is rejected. `fail_count` is incremented on a transport failure and reset by a successful test or a later successful request; a candidate is benched when it reaches the configured `autoDisableAfter`. `last_error` stores a short code, never a URL or credential. Deleting a row rewrites any `pinned` assignment that referenced it to `global`.

### `custom_models`

Provider/model pair and creation timestamp. Primary key is `(provider, model)`.

### `custom_providers`

Custom provider ID, stable source ID, display name, website, base URL, chat path, aliases, safe static headers, JSON model list, creation timestamp.

### `provider_overrides`

Persisted editable configuration for shipped providers, keyed by stable source ID. It stores the current routable ID, aliases, display/base URL configuration, safe static headers, models, and update timestamp. Changing the current ID transactionally migrates `accounts` and `custom_models` provider references.

### `account_usage`

Per-account per-day request/token counters. Primary key is `(account_id, day)`. Day keys are UTC and are used only by the account pages.

### `usage_hourly`

Global request/error/token history for the dashboard usage page. Primary key is `(bucket, provider, model)`.

- `bucket` is a local-time hour key, `YYYY-MM-DDTHH`. Day, week, month, and all-time reports are `SUM()` rollups over this table, so a new range needs no new table.
- `latency_ms` and `latency_count` are accumulated separately, so the report can show an average without dividing by requests (failed rows have no latency).
- Errors recorded before an upstream call (bad model, no credential) use an empty `model`, so they count in totals but never appear as a model row.
- `usage_hourly` starts empty on upgrade: there is no backfill from `account_usage`, because that table has no provider/model dimension.

### `budget_usage`

Daily request/token/cost counters for scopes that have a limit configured. Primary key is `(day, scope)`; `scope` is `key:<managed key id>` or `provider:<provider id>`.

- `day` is the server's local calendar day, so budgets reset at local midnight rather than UTC.
- Cost is stored as integer micro-USD (`cost_micro`), estimated from the same price table as the Usage page. Unpriced models add tokens with zero cost.
- Only scopes with a configured limit at request time are recorded, and only completed requests carrying usage are counted.
- Rows older than 90 days are pruned once per day; `meta.budget_pruned` remembers the last pass.

### `chat_sessions` and `chat_messages`

Chat dashboard history is local SQLite state. Sessions store title/model/timestamps; messages store role, bounded JSON content, optional reasoning text, status, and sequence. No API keys or provider credentials are stored there. Uploaded images/text are bounded by the dashboard and history API limits. Chat history does not grant tools, shell access, or filesystem access.

### Account refresh metadata

`accounts.last_refresh_at` tracks provider OAuth refreshes. Existing databases receive the nullable column through an idempotent migration. Codex refresh rotation requires the replacement refresh token; if the provider omits it, norouter refuses to commit the new access token. Antigravity refreshes rotate the stored access/refresh pair; the existing `project_id` binding is left untouched.

Buckets follow the server machine's timezone. Changing the OS timezone affects only new rows; earlier rows keep the key they were written with.

## Persistence split

Live dashboard counters (`noroute_src/lib/stats.js`) remain in memory and reset after restart. Account counters, custom providers/models, daily account usage, daily budget counters, scheduler state, proxy rows, proxy settings/assignments, and the global `usage_hourly` history persist in SQLite. Proxy rotation cursor, test/scrape job snapshots, and proxy counters are memory-only.

Timezone note: `account_usage` and `api_key_usage` use UTC day keys, `budget_usage` (and the `budgets` meta snapshot) uses local-time day keys, and `usage_hourly` uses local-time hour keys.

## Legacy migration

Old `data/custom-models.json` and `data/custom-providers.json` are imported once when SQLite initializes, then renamed to `.migrated`. Migration files can contain provider configuration; treat them as local state.

## Backup

Stop the server before a simple file copy backup, or use a SQLite-aware backup that includes WAL state. Never publish the DB or sidecars. Restore all required SQLite files together, then verify with `npm test` or a local health check in an isolated copy.
