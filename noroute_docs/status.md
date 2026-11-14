# Implementation status

## Implemented

- Dependency-free Node HTTP server.
- SQLite persistence with WAL and legacy JSON migration.
- CodeBuddy CN OpenAI-compatible chat provider.
- Codex provider with ChatGPT OAuth (PKCE, browser callback) and Responses wire.
- Antigravity provider: Google OAuth (browser callback on port 1456), Cloud Code
  `v1internal` envelope around Gemini `contents`, stream/non-stream translation,
  tool-call and schema conversion, per-account project binding, and per-account
  quota from the Cloud Code summary (shared weekly/5h pools per model family,
  per-model fallback for paid tiers). The gateway
  is undocumented and flagged deprecated upstream (`RISK_NOTICE`); no OAuth
  client is bundled, so login needs `ANTIGRAVITY_CLIENT_ID` and
  `ANTIGRAVITY_CLIENT_SECRET` from the environment.
- Manual SQLite account pool as the only upstream credential source.
- Round-robin account selection, cooldown, refresh-token exchange, pause/resume.
- Account pagination, bulk import, preview, masking, duplicate detection by fingerprint and durable provider UID, and a per-account subscription tier (free, plus, pro, ultra, team, business, enterprise).
- OAuth re-login refreshes the existing pooled row instead of adding a twin; startup backfills UID/plan from stored tokens and merges any pre-existing duplicate rows.
- Pool-level account actions: daily check-in for all enabled OAuth accounts, provider-native test across all accounts, and manual warmup of expired parked accounts.
- Per-account ping (one real chat turn) and per-account warmup.
- Provider/model dashboard CRUD and conventional model fetch.
- Active-account model test with diagnostic answer toast.
- CodeBuddy billing meter parser and per-account quota action.
- Dashboard themes, accents, splash, route/modal/toast transitions, split into per-area classic scripts served individually.
- Live service map page (`/map`) driven by a per-request SSE lifecycle stream (`/api/live`), with real-traffic particles, session counters, and a 12-event feed; the stream carries no account, credential, prompt, or response data.
- Inbound OpenAI Responses API (`/v1/responses`): translated onto the chat
  pipeline, rebuilt as Responses stream events or a `response` object, including
  streamed tool calls and vision routing.
- Inbound Anthropic Messages API (`/v1/messages`): translated onto the chat
  pipeline, rebuilt as Messages events (thinking, text, complete `tool_use`
  blocks) or a `message` object, including vision routing and Anthropic-shaped
  errors.
- In-memory global usage/activity stats.
- Model aliases, ordered conditional routing rules (header, managed key, context
  size, tools), and per-key default models. One settings snapshot drives both
  lookup steps, targets are canonicalised on save, and the request log records
  the requested model, route reason, via name, and attempted chain.
- Managed API keys with custom/automatic secrets, expiry, request/token limits, and daily usage history.
- Daily token/cost budgets per managed API key and per provider, stored in `meta` with counters in `budget_usage` (local-day reset, 90-day retention). A capped key gets 429 `budget_exhausted`; a capped provider is skipped by failover chains; a `budget` webhook event fires once per scope per day.
- Background maintenance scheduler: token refresh (10 min), quota refresh (6 h), and Codex model catalog (12 h), with a configurable 15-minute default tick, a 5–1440 minute interval, per-task last result, and a manual **Run all now** that works while the scheduler is off. State persists in `meta`; task throws surface as `error` webhook events with `scope: "maintenance"`.
- Optional data-plane proxy egress: a persisted proxy pool with masked URLs, manual add/import, opt-in validated free-proxy scraping, HTTP CONNECT and SOCKS4/4a/5/5h transport (including proxy authentication and target TLS), global/round-robin or random selection, per-provider `global`/`direct`/`pinned` routing, Strict or direct fallback, benching by failure count, and a `/proxy` dashboard page. OAuth refresh, quota, catalog, and dashboard traffic stay direct.
- Native Windows/Linux autostart settings and confirmation-gated uninstall CLI.
- Local upstream stub and smoke suite at last verification.

## Deliberately absent

- Device-code polling and OAuth flows that do not use a local browser callback.
- MITM root CA.
- Subscription credential reuse outside the provider's own OAuth login.
- Translation to upstreams other than the supported wires (OpenAI Chat,
  OpenAI Responses, Anthropic Messages, Antigravity Cloud Code/Gemini).
- Multi-provider fallback.
- Admin API authentication/RBAC/audit log; dashboard page password is not admin API authentication.
- TLS, rate limiting, CSRF protection, SSRF allowlist.
- Persistent global request history.

## Known limitations

- Dashboard HTML may use an optional page password; `/api` remains unauthenticated.
- `REQUIRE_API_KEY` gates only `/v1`; per-key defaults and `apiKeyId` rule matches therefore apply only while it is on.
- CORS is unrestricted.
- SQLite credentials are plaintext at rest.
- Custom provider URLs accept arbitrary HTTP(S) destinations.
- Built-in model catalog is a repository snapshot.
- CodeBuddy quota body/host/fields are upstream-dependent.
- Dashboard visual/accessibility behavior is not fully automated.
- Free proxy sources are public and unreliable; validation drops most candidates, and a proxy can still block, delay, or inspect data-plane traffic. Treat the pool as untrusted.
- Failed streams end with one error frame (`code: "stream_truncated"` / `"stream_error"`) and no `[DONE]`; the message text still comes from the upstream and differs per provider.
- Daily budget cost is a local estimate from list prices, not provider billing. Unpriced models add tokens but zero cost, counters exist only for traffic routed through norouter, and they start when a limit is first configured.

## Research confidence

Mirai and related implementations corroborate CodeBuddy request streaming, rate-limit parsing, refresh behavior, and broad quota package field conventions. They do not create an official immutable billing contract. Norouter should not change quota formulas without a controlled real payload or stronger upstream evidence.
