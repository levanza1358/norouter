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
            ├── daily budget gate (key, then provider per attempt)
            ├── model resolver
            ├── account pool / .env credential resolution
            ├── provider chat endpoint
            ├── proxy egress (optional CONNECT/SOCKS tunnel)
            ├── SSE relay or accumulator
            └── in-memory stats + SQLite account counters
```

No framework, bundler, or dependency. Node HTTP server owns routing. The dashboard is static HTML/CSS/JS served by the same process.

## Startup

1. `noroute_src/config.js` loads root `.env` without interpolation; existing process env wins.
2. Provider registry loads shipped providers (CodeBuddy CN, Codex, Antigravity) and saved custom providers from SQLite.
3. SQLite opens lazily, enables WAL/NORMAL/busy timeout, creates schema, and migrates legacy JSON once.
4. Server binds `HOST:PORT`.
5. The maintenance scheduler starts with the process entry point: one timer at the configured interval, first tick after a full interval, tasks refresh tokens (10 min), quota (6 h), the Codex catalog (12 h), and stale proxy health (30 min, plus optional auto-scrape).
6. Dashboard loads saved theme/accent before first paint, shows splash, then polls status.

## Model resolution

`resolveModel()` accepts provider alias/model, provider ID/model, or bare model. Bare model is valid only when one provider owns that ID. Catalog plus custom models are resolved before upstream call.

## Routing precedence

`handleChat` applies routing in one ordered pass: vision routing (a new image) → per-key default (only when `model` is missing, and only with `REQUIRE_API_KEY` plus a managed key) → alias rewrite → first matching routing rule → combo → single model. Aliases and rules share one `meta.routing_rules` snapshot per request, targets are canonicalised when saved, and both resolve through the same model resolver as a direct request. A rule may only name models; an alias may also name a combo. Rules are ordered and their conditions are ANDed; an enabled rule with no resolvable target is skipped. The trace records the requested model, the reason (`direct`, `combo`, `vision`, `alias`, `rule`), the via name, and every attempted target.

A per-key daily budget is checked once, immediately after the body is parsed and before vision, aliases, rules, or combos can spend an upstream call; a scope at its cap returns 429 `budget_exhausted`. The provider budget is checked once per attempt inside the single-model path, so a capped provider behaves like any other failed attempt and the chain continues with the next target instead of failing the request.

## Chat lifecycle

1. Parse JSON with request size limits.
2. Refuse a managed key whose daily token/cost budget is already reached (429, no upstream call).
3. Resolve provider/model.
4. Select account pool credential, refresh manually stored CodeBuddy refresh token when needed, or fall back to `.env`.
5. Reject missing credential unless provider is explicitly open.
6. Force CodeBuddy upstream stream.
7. For client stream: relay SSE frames and tap accumulator for usage/counters. Empty `tool_calls` arrays from any upstream delta are dropped so SDKs do not split reasoning into one block per token. A non-canonical `reasoning` field is mirrored onto `reasoning_content` before the frame is relayed and accumulated.
8. For a non-streamed client turn, accumulate SSE into one OpenAI-shaped completion. Add `stream_options.include_usage`; retry once without it if upstream rejects that field. A `stream: true` client turn asks for the same usage chunk, because that is the only frame carrying token counts for a streamed reply.
9. On 401/403, refresh account once and retry. On 429, mark account cooldown using `Retry-After`, timestamp, or default. Other 400/404/500 errors relay without pointless account rotation.
10. Record process stats and account counters, and add token/cost counters to the limited budget scopes. Successful calls and errors are also written to `usage_hourly` in SQLite through `noroute_src/lib/usage.js`; the in-memory snapshot stays the fast path for `/api/status`.

## Inbound API translation

`/v1/responses` converts a Responses request into a chat body and replays it through `handleChat` with a response sink, so routing, pooling, failover, vision, and truncation handling stay in one place. The sink holds bytes back until the first translated event and then rebuilds chat frames into Responses events; a failure before that point can still return a real HTTP error. Non-stream requests return one `response` object. Translation never changes the outbound wires.

`/v1/messages` follows the same pattern for the Anthropic Messages shape. Chat tool calls may interleave, so the sink buffers them and emits complete `tool_use` blocks before `message_stop`; text and reasoning deltas stream live. Route errors are rewritten in Anthropic error shape.

## Account pool

- SQLite stores raw operator-supplied credential values; public objects call `publicAccount()` and expose only masked values/booleans.
- Fingerprint is SHA-256 of `kind:secret`; unique per provider.
- `pickAccount()` rotates enabled, non-cooldown, non-error accounts.
- Account model test uses only `pickAccount()`, so disabled/cooling/error accounts are not candidates.
- Bulk import runs in a transaction.
- Preview reads existing fingerprints and incoming fingerprints but never writes.
- Refresh calls are deduplicated per account.

## Proxy egress

Data-plane calls may be routed through an operator-managed proxy pool. The choice is resolved per upstream attempt from `meta.proxy_settings` and `meta.proxy_assignments`: master switch off → direct; provider assigned `direct` → direct; `pinned` → that proxy; missing or `global` → shared pool with round-robin or random selection. Candidates are enabled rows below the auto-bench failure threshold. If no candidate is usable, the attempt falls back to direct unless Strict is on, in which case it returns `502 proxy_unavailable` before any upstream request.

The transport is dependency-free (`node:net`/`node:tls`/`node:http`): HTTP `CONNECT`, TLS-to-proxy for `https://`, and SOCKS4/4a/5/5h handshakes. A tunnel is opened first, then the target request is written over the socket (wrapped in TLS for an HTTPS target). The result is rebuilt as a standard `Response`, so chat streaming, buffering, wire translation, account retry, and SSE relay are untouched. One retry on a second proxy is allowed only for a pre-header transport failure; any HTTP status from the target counts as a tunnel success. Proxy failures never mark an account as failed. Catalog fetch, quota, OAuth, and dashboard traffic stay direct.

Pool state (URLs with credentials, enabled flag, health, settings, assignments) is SQLite. Rotation cursor, job state, and counters are memory. URL grammar, masking, scraping, and failure codes are in [proxy.md](proxy.md).

## Provider adapters

Built-in CodeBuddy has provider metadata plus CodeBuddy-specific refresh/quota modules. Codex adds the Responses wire and ChatGPT OAuth; Antigravity adds the Cloud Code `v1internal` envelope, Gemini `contents` translation, Google OAuth with project binding, and a quota reader over `loadCodeAssist` plus `retrieveUserQuotaSummary` (shared weekly/5h pools per model family, with per-model `fetchAvailableModels` as a paid-tier fallback). Custom providers are generic OpenAI-shaped forwarding only; no translation, custom headers, or generic refresh.

## Dashboard

The UI has page surfaces for dashboard, service map, providers, usage, chat, combos, proxy, settings, and API keys, plus provider detail. App state is browser memory. Status/detail polling refreshes visible data; a separate `GET /api/live` SSE stream carries per-request lifecycle deltas for the service map, so particles and counters reflect real traffic while topology and health stay on the two-second `/api/status` poll. Account rows are server-paginated. Theme/accent are localStorage-only. Model tests return `answer` and display a bounded escaped toast in the bottom-right.

## Persistence boundary

| Data | Storage | Restart behavior |
|---|---|---|
| Global request/error/history stats | memory | reset |
| Account records/counters/daily usage | SQLite | persist |
| Custom providers/models | SQLite | persist |
| Daily budgets and scheduler state | SQLite (`meta` + `budget_usage`) | persist |
| Proxies, proxy settings, assignments | SQLite (`proxies` + `meta`) | persist |
| Proxy rotation cursor, jobs, counters | memory | reset |
| Theme/accent | browser localStorage | persist per browser |
| Raw credential values | SQLite or process env | persist according to source |

## Failure boundary

Upstream response bodies may be passed through. A turn counts as success only when the upstream proves termination (`finish_reason`, `[DONE]`, `response.completed`, `message_delta`/`message_stop`, or Gemini `finishReason`). A stream cut before that, or an upstream error frame, ends with one error frame (`code: "stream_truncated"` / `"stream_error"`) and no `[DONE]`; buffered and non-stream failures become 502. The implementation does not provide a universal error envelope for every upstream.
