# System design

## Runtime shape

```text
client
  │
  ├── GET /, /providers, /usage, /settings
  │       dashboard shell + vanilla JS router
  │
  └── /v1/*
          server.js
            ├── auth gate (optional, /v1 only)
            ├── model resolver
            ├── account pool / .env credential resolution
            ├── provider chat endpoint
            ├── SSE relay or accumulator
            └── in-memory stats + SQLite account counters
```

No framework, bundler, or dependency. Node HTTP server owns routing. The dashboard is static HTML/CSS/JS served by the same process.

## Startup

1. `src/config.js` loads root `.env` without interpolation; existing process env wins.
2. Provider registry loads built-in CodeBuddy CN and saved custom providers from SQLite.
3. SQLite opens lazily, enables WAL/NORMAL/busy timeout, creates schema, and migrates legacy JSON once.
4. Server binds `HOST:PORT`.
5. Dashboard loads saved theme/accent before first paint, shows splash, then polls status.

## Model resolution

`resolveModel()` accepts provider alias/model, provider ID/model, or bare model. Bare model is valid only when one provider owns that ID. Catalog plus custom models are resolved before upstream call.

## Chat lifecycle

1. Parse JSON with request size limits.
2. Resolve provider/model.
3. Select account pool credential, refresh manually stored CodeBuddy refresh token when needed, or fall back to `.env`.
4. Reject missing credential unless provider is explicitly open.
5. Force CodeBuddy upstream stream.
6. For client stream: relay SSE frames and tap accumulator for usage/counters. Empty `tool_calls` arrays from any upstream delta are dropped so SDKs do not split reasoning into one block per token.
7. For client non-stream: accumulate SSE into one OpenAI-shaped completion. Add `stream_options.include_usage`; retry once without it if upstream rejects that field.
8. On 401/403, refresh account once and retry. On 429, mark account cooldown using `Retry-After`, timestamp, or default. Other 400/404/500 errors relay without pointless account rotation.
9. Record process stats and account counters. Successful calls and errors are also written to `usage_hourly` in SQLite through `src/lib/usage.js`; the in-memory snapshot stays the fast path for `/api/status`.

## Account pool

- SQLite stores raw operator-supplied credential values; public objects call `publicAccount()` and expose only masked values/booleans.
- Fingerprint is SHA-256 of `kind:secret`; unique per provider.
- `pickAccount()` rotates enabled, non-cooldown, non-error accounts.
- Account model test uses only `pickAccount()`, so disabled/cooling/error accounts are not candidates.
- Bulk import runs in a transaction.
- Preview reads existing fingerprints and incoming fingerprints but never writes.
- Refresh calls are deduplicated per account.

## Provider adapters

Built-in CodeBuddy has provider metadata plus CodeBuddy-specific refresh/quota modules. Custom providers are generic OpenAI-shaped forwarding only; no translation, custom headers, or generic refresh.

## Dashboard

The UI has five route surfaces plus provider detail. App state is browser memory. Status/detail polling refreshes visible data. Account rows are server-paginated. Theme/accent are localStorage-only. Model tests return `answer` and display a bounded escaped toast in the bottom-right.

## Persistence boundary

| Data | Storage | Restart behavior |
|---|---|---|
| Global request/error/history stats | memory | reset |
| Account records/counters/daily usage | SQLite | persist |
| Custom providers/models | SQLite | persist |
| Theme/accent | browser localStorage | persist per browser |
| Raw credential values | SQLite or process env | persist according to source |

## Failure boundary

Upstream response bodies may be passed through. Non-stream accumulated SSE errors become 502; streamed bytes are relayed. The implementation does not provide a universal error envelope for every upstream.
