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

### `accounts`

Stores provider ID, label, kind, access token, refresh token, UID, SHA-256 fingerprint, enabled flag, expiry/cooldown, last error/use, counters, and timestamps.

Important: credential columns are plaintext values in the local SQLite file. Protect the file with OS permissions, backups, and disk encryption.

Unique index: `(provider, fingerprint)`.

Fingerprint input:

```text
SHA-256(`${kind}:${secret}`)
```

The fingerprint is never returned to the API/UI.

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

### `chat_sessions` and `chat_messages`

Chat dashboard history is local SQLite state. Sessions store title/model/timestamps; messages store role, bounded JSON content, optional reasoning text, status, and sequence. No API keys or provider credentials are stored there. Uploaded images/text are bounded by the dashboard and history API limits. Chat history does not grant tools, shell access, or filesystem access.

### Account refresh metadata

`accounts.last_refresh_at` tracks provider OAuth refreshes. Existing databases receive the nullable column through an idempotent migration. Codex refresh rotation requires the replacement refresh token; if the provider omits it, norouter refuses to commit the new access token.

Buckets follow the server machine's timezone. Changing the OS timezone affects only new rows; earlier rows keep the key they were written with.

## Persistence split

Live dashboard counters (`src/lib/stats.js`) remain in memory and reset after restart. Account counters, custom providers/models, daily account usage, and the global `usage_hourly` history persist in SQLite.

Timezone note: `account_usage` and `api_key_usage` use UTC day keys, while `usage_hourly` uses local-time hour keys.

## Legacy migration

Old `data/custom-models.json` and `data/custom-providers.json` are imported once when SQLite initializes, then renamed to `.migrated`. Migration files can contain provider configuration; treat them as local state.

## Backup

Stop the server before a simple file copy backup, or use a SQLite-aware backup that includes WAL state. Never publish the DB or sidecars. Restore all required SQLite files together, then verify with `npm test` or a local health check in an isolated copy.
