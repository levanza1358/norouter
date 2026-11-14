# Dashboard and admin API

These endpoints are administration surfaces. They are **not** covered by `REQUIRE_API_KEY`; the default bind is `0.0.0.0`, so add a firewall/reverse-proxy authentication boundary before network exposure or set `HOST=127.0.0.1`. Provider credentials are managed in the SQLite account pool, not `.env`.

Dashboard password, when enabled, gates dashboard HTML pages only. `/api/*`, assets, and model/provider operations remain available to the local operator after the page session expires. This is intentionally not network authentication; use a firewall/reverse proxy for remote access or set `HOST=127.0.0.1`.

`<id>` and `<accountId>` are URL-encoded provider/account IDs.

## API keys

| Method | Path | Notes |
|---|---|---|
| GET | `/api/keys` | List key metadata including plaintext managed tokens for Show/Hide/Copy |
| POST | `/api/keys` | Create key; response includes plaintext `secret` |
| PATCH | `/api/keys/:id` | Update name, enabled, expiry, request/token limits, default model |
| DELETE | `/api/keys/:id` | Revoke a managed key and its usage history |
| GET | `/api/keys/:id/usage?days=30` | Daily request/token history |
| POST | `/api/keys/:id/rotate` | Replace the token; raw replacement `secret` returns once |
| GET/PATCH | `/api/auth-settings` | Read or set `requireApiKey` for `/v1` |
| GET/PATCH | `/api/token-saver` | Read or set the dependency-free token-saver transforms |

Token Saver defaults to `{ ponytail: { enabled: false }, rtk: { enabled: false }, caveman: { enabled: false } }`. PATCH accepts `{ ponytail: { enabled } }`, `{ rtk: { enabled } }`, and `{ caveman: { enabled } }` (any subset). The transforms only apply to Chat Completions requests with a `messages` array, and change system instructions without changing user or assistant messages.

- **RTK** compresses tool output (git diff context lines, grep/list dedup, repeated log lines, oversized-output truncation) before the request reaches the model. Pure string transforms, no dependency, and every filter fails open — it never makes a request larger or breaks it.
- **Ponytail** injects a lazy-senior-dev (YAGNI) system instruction.
- **Caveman** injects a terse-output instruction; it stacks with Ponytail.
- **Headroom** is intentionally not included: it requires an external proxy (`pip install`).

## Reply style

| Method | Path | Notes |
|---|---|---|
| GET | `/api/reply-filters` | Current `{ language, verbosity, coding, focus, addressAs }`. |
| PATCH | `/api/reply-filters` | Any subset of those fields; 400 on invalid values. |

Defaults are `{ "language": "auto", "verbosity": "balanced", "coding": false, "focus": "", "addressAs": "" }`. The resulting lines are appended to the first system message (or a new one is created) for `/v1/chat/completions`, `/v1/responses`, and `/v1/messages` after request translation. Every injected line carries the `[norouter reply style]` marker, so replaying returned history does not duplicate it; when every field is a no-op the request body is untouched.

- `language`: `auto`, `none`, or a two-letter catalog code.
- `verbosity`: `balanced`, `concise`, or `detailed`.
- `coding`: boolean; prefers short, minimal code.
- `focus`: free-form guidance, at most 2,000 characters; each non-empty line is added as its own instruction.
- `addressAs`: the name or nickname the model should use for the operator, at most 60 characters on a single line.

These settings change the system prompt sent upstream; they are stored in the local SQLite `meta` table, not in `.env`.

Managed keys are stored as plaintext in SQLite so the dashboard can show, hide, copy, and edit them. Create accepts `name`, optional custom `secret`, optional future `expiresAt`, `requestLimit`, `tokenLimit`, and `defaultModel`; token limits accept integer counts or compact suffixes `K`, `M`, `B`, and `T` (for example `1M` = 1,000,000 tokens); the dashboard exposes these as a unit dropdown; `None` disables token-limit input, and request limits use a separate enable toggle. `defaultModel` may name a model or a combo; it is stored canonically and only fills a request that sends no `model` while the key authenticates the call (see [`openai.md`](openai.md#aliases-routing-rules-and-per-key-defaults)). Omitted limits are unlimited. Request limits count admitted chat requests; token limits count reported prompt plus completion tokens. The dashboard page may require its optional page password, but `/api` routes remain unauthenticated; protect the all-interface bind with a firewall/reverse proxy or set `HOST=127.0.0.1`, and treat its database, WAL/SHM, and backups as secret material.

## Autostart

| Method | Path | Notes |
|---|---|---|
| GET | `/api/settings/autostart` | Returns actual OS registration status, support, and platform. |
| PATCH | `/api/settings/autostart` | `{ "enabled": true|false }`; registers or removes native Windows Task Scheduler or Linux user-systemd autostart. |

Autostart definitions contain only the executable and repository path. They do not contain `.env` values or credentials.

## Dashboard port

| Method | Path | Notes |
|---|---|---|
| GET | `/api/settings/port` | Current bind host and port |
| PATCH | `/api/settings/port` | `{ "port": 5555 }`; probes availability, persists to ignored `config.local.json`, then rebinds the server. Returns 409 when occupied. |

The default port is `5555`. The browser reconnects to the new port after a successful change.

## Account backup & restore

| Method | Path | Notes |
|---|---|---|
| GET | `/api/settings/accounts/export` | Download the account pool as a `.json` attachment (raw tokens). |
| POST | `/api/settings/accounts/restore` | Merge a backup into the pool; skips duplicates, never deletes. |

The export is an operator backup file — it contains **plaintext** `access_token`, `refresh_token`, `uid`, and `plan` values on purpose, because it is the credential source for a restore. Treat the downloaded file like the database itself: store it off the server, keep it secret, and delete copies you no longer need. It never contains dashboard passwords, managed API-key secrets, or `.env` values.

Restore accepts either a bare account array or an `{ "accounts": [...] }` wrapper, at most 5,000 rows. It merges by provider identity (`uid`) first and fingerprint second: existing accounts are untouched, a restored row whose identity is already pooled is skipped even when its token was rotated, and unknown provider IDs are counted without being written. The response is `{ added, duplicates, invalid, unknownProviders, total }`. Accounts with `expires_at` in the past are imported without an expiry rather than forced into cooldown.

## Request log

| Method | Path | Notes |
|---|---|---|
| GET | `/api/request-log` | Last 200 chat requests as redacted metadata (no tokens, keys, or bodies). |
| DELETE | `/api/request-log` | Clear the in-memory ring buffer. |

The log is an in-memory ring buffer: it survives no restart and never touches SQLite. Each entry carries `at`, `status`, `provider`, `model`, `account` (label), `tokensIn`, `tokensOut`, `ms`, and a redacted `error`. Credentials and message bodies are never captured, so there is nothing sensitive to scrub on the way out.

## Webhook

| Method | Path | Notes |
|---|---|---|
| GET | `/api/webhook` | Read `{ enabled, url, events }`. |
| PATCH | `/api/webhook` | `{ "enabled": true, "url": "https://example.com/hook" }`; validates the URL is http(s). |

When enabled, norouter POSTs a JSON notification to `url` on three events — `request` (a completed chat), `error` (a recorded error), and `cooldown` (an account parked). A fourth event, `budget`, fires once per scope per local day when a daily limit is crossed. Payloads are metadata only: provider, model, account label, status, latency, and token counts — never credentials or message bodies. Delivery is fire-and-forget with a 5s timeout; failures are swallowed so a notification can never slow or break the request it describes.

## Budgets

| Method | Path | Notes |
|---|---|---|
| GET | `/api/budgets` | Today's counters plus every key/provider limit |
| PATCH | `/api/budgets` | Update `enabled`, `keys`, `providers`; returns the same payload |

The payload is `{ enabled, day, keys, providers }`. `day` is the local calendar day (`YYYY-MM-DD`) the counters belong to, so a budget resets at the server machine's midnight. Each row carries `limit` (`{ tokens, cost }` or `null`), today's `used` counters, and `percent` / `costPercent` when that dimension has a limit. `cost` is an estimate in USD from the same price table as the Usage page; a model without a price still counts tokens but contributes zero cost. No key secret or account credential is included.

PATCH accepts `{ enabled?, keys?, providers? }`:

- `keys` and `providers` are objects keyed by key ID / provider ID.
- A scope object **replaces** that scope's whole limit: `{ "tokens": 200000 }` alone drops a previously configured cost cap.
- `null` deletes the scope; omitting a scope keeps it.
- A limit needs at least one of `tokens` (positive integer) or `cost` (positive finite USD); anything else returns 400.

Enforcement: a managed API key that has reached its limit is refused at `POST /v1/chat/completions` with 429 before any upstream call — `{ "error": { "message", "type": "budget_error", "code": "budget_exhausted", "scope", "day", "reasons", "limit", "used" } }`. A capped provider is not a client error: failover chains skip it and continue with the next target, so a request only fails when no other target can serve it. Counters are written for completed requests with usage, and only for scopes that had a limit at request time. Limits are edited on Settings → Daily budgets; see [`../dashboard.md`](../dashboard.md#daily-budgets).

## Maintenance

| Method | Path | Notes |
|---|---|---|
| GET | `/api/maintenance` | Scheduler settings, running state, per-task state |
| PATCH | `/api/maintenance` | `{ enabled?, intervalMinutes? }`; interval is an integer 5–1440 |
| POST | `/api/maintenance/run` | `{ "tasks": ["tokens", "quota", "catalog"] }`; body may be empty or omit `tasks` to run only due tasks |

The snapshot is `{ settings: { enabled, intervalMinutes }, running, lastTickAt, tasks }`. Each task carries `id`, `label`, `everyMinutes`, `lastRunAt`, `lastResult` (`{ ok, summary, ms }` or `null`), `nextDueAt`, and `due`. Tasks are token refresh (10 minutes), quota refresh (6 hours), and model catalog (12 hours). `POST /api/maintenance/run` works even while the scheduler is disabled and returns `{ results, snapshot }`; an unknown task ID returns 400. The timer only runs while the server process is up, and the first automatic tick happens after one full interval, so a restart never triggers upstream traffic immediately.

## Proxy egress

| Method | Path | Notes |
|---|---|---|
| GET | `/api/proxy` | Settings, masked pool, assignments, counters, job snapshots |
| PATCH | `/api/proxy` | Master switch, strategy, strict, auto-bench, scrape schedule |
| POST | `/api/proxies` | Add one proxy; tests by default but stores even when the test fails |
| PATCH | `/api/proxies/:id` | Update `enabled` or `label` only; the URL is immutable |
| DELETE | `/api/proxies/:id` | Delete; pinned assignments fall back to `global` |
| POST | `/api/proxies/:id/test` | Synchronous tunnel test, 8 second budget |
| POST | `/api/proxies/import` | Parse up to 1000 pasted lines or a JSON array; no testing |
| POST | `/api/proxies/test` | Background test of all or selected proxies; 409 when a job is running |
| PUT | `/api/proxy/providers/:id` | Set one provider to `global`, `direct`, or `pinned` |
| POST | `/api/proxy/scrape` | Opt-in scrape and validate; 202, or 409 when already running |

Proxy URLs may carry `user:pass`, are stored plaintext in SQLite, and are never returned: responses only expose a masked URL plus `hasAuth`. Full request/response fields, selection rules, failure codes, and scraping behavior are in [`proxy.md`](proxy.md). These endpoints are unauthenticated like the rest of `/api`.

## Status/provider

| Method | Path | Notes |
|---|---|---|
| GET | `/api/status` | In-memory status snapshot, last 40 history rows and last 60 events |

## Live request stream

| Method | Path | Notes |
|---|---|---|
| GET | `/api/live` | Server-sent events for the `/map` service map: request lifecycle deltas, never bodies |

The stream opens with `retry: 3000`, then a `hello` frame that lists in-flight requests as `{ provider, model, ms }`, then one frame per lifecycle phase:

```json
{"phase":"hello","now":1730000000000,"active":[{"provider":"cbcn","model":"glm-5.3","ms":812}]}
{"phase":"start","id":"r-42","at":1730000000100,"kind":"chat","model":"cbcn/glm-5.3","stream":true,"tools":false}
{"phase":"route","id":"r-42","at":1730000000120,"provider":"cbcn","model":"glm-5.3","attempt":1}
{"phase":"first","id":"r-42","at":1730000000450,"provider":"cbcn","model":"glm-5.3","status":200}
{"phase":"finish","id":"r-42","at":1730000001200,"provider":"cbcn","model":"glm-5.3","status":200,"ms":1100,"tokensIn":12,"tokensOut":48,"tool":false,"stream":true,"kind":"chat"}
{"phase":"error","id":"r-43","at":1730000000000,"provider":"cbcn","model":"…","status":429,"stage":"upstream"}
```

`kind` is `chat`, `image`, or `embed`; `error.stage` is `model`, `credential`, `upstream`, or `client`. Frames deliberately carry no account label, credential, header, prompt or response text, or upstream error message. A `: ping` comment is written every 25 seconds so proxies keep the connection open. Publishing is a no-op while no client is subscribed, and the active-request snapshot is allowlisted to provider, model, and elapsed milliseconds before it leaves the process.

Like every `/api` route, `/api/live` is unauthenticated and the default bind is `0.0.0.0`; keep it local or put auth and TLS in front.

## Combos

| Method | Path | Notes |
|---|---|---|
| GET | `/api/combos` | List combos with their ordered model lists |
| POST | `/api/combos` | Create `{ name, models: string[] }`; returns 201 |
| GET | `/api/combos/:id` | One combo |
| PATCH | `/api/combos/:id` | Update `name` and/or `models`; omitted fields are kept |
| DELETE | `/api/combos/:id` | Delete; returns 200 |
| GET | `/api/vision-routing` | Vision rule plus the enabled-model catalog |
| PATCH | `/api/vision-routing` | Update `enabled`, `strategy`, `models`; omitted fields are kept |

Validation is enforced at the HTTP boundary:

- `name` is required, at most 60 characters, must start with a letter or digit, may use letters, digits, `.`, `_` and `-`, and may **not** contain `/` (that form belongs to `provider/model`). Names are unique — a duplicate returns 409.
- `models` must be a non-empty array of non-empty strings. Every entry must resolve through the normal model resolver, so a combo can never be saved pointing at a model the router would reject. The array order is the fallback priority and is stored verbatim.
- Vision `models` follow the same resolver rule (at most 20 entries, stored canonically as `prefix/model`, duplicates rejected), and `strategy` is `order` or `round-robin`. Enabling with an empty list returns 400; partial PATCHes keep whatever they omit.

Errors use the shared `{ error: { message, type } }` shape: 400 for validation, 404 for an unknown id, 409 for a duplicate name.

Combo routing behavior (fallback statuses, streaming safety, attribution) is documented in [`openai.md`](openai.md#combos). Vision routing is covered in [`openai.md`](openai.md#vision-routing) and [`dashboard.md`](../dashboard.md#vision-routing).
| GET | `/api/usage?range=day\|week\|month\|all` | Persistent usage report from SQLite |

The usage report returns a `cost` field on `totals` and on each model row, an estimate in USD computed from per-model list prices. Models without a price (combos and custom models) report `null`, and the dashboard shows `—` rather than inventing a number. Cost is a comparison/savings figure only — norouter never bills anyone; you pay providers directly.
| GET | `/api/providers/:id` | Provider snapshot, pool counts, local quota, models |
| POST | `/api/providers` | Create custom provider; returns 201 |
| PATCH | `/api/providers/:id` | Persist provider configuration; ID changes migrate accounts/models atomically |
| DELETE | `/api/providers/:id` | Delete custom provider only |

Create and PATCH bodies accept `id`, `aliases`, `name`, `website`, `baseUrl`, `chatPath`, `headers`, `models`, `format`, `forceStream`, `requiresAccount`, `baseUrlEnv`, `refresh`, `quota`, `checkin`, and `accountStrategy`. GET snapshots expose the editable stored/catalog fields at `provider.config`. PATCH merges omitted fields with the current configuration; all resulting fields are persisted for both shipped and custom providers. A provider's `source_id` remains stable across ID changes and restarts.

`accountStrategy` controls how the provider spends its account pool:

| Value | Behavior |
|---|---|
| `round-robin` (default) | Each request advances to the next active account. |
| `sequential` | Reuse the first active account until it cools down or errors, then move to the next. |
| `highest-quota` | Prefer the active account with the most remaining quota from the last quota read. Accounts with no reading come after measured ones; known-empty accounts come last. |

Any other value returns 400. Cooling, disabled, and errored accounts are skipped by every strategy, and a provider that has never been read still routes in add order.

`headers`, `refresh.headers`, `quota.headers`, and `checkin.headers` must be JSON objects with static non-secret values. `Authorization`, `Cookie`, API-key, token, secret, and credential headers are rejected; credentials remain exclusively in the SQLite account pool. URLs must be HTTP(S), without URL credentials or fragments. Changes do not contact the provider automatically; use account/model checks explicitly after saving.

```json
{
  "id": "local-ollama",
  "aliases": ["ollama"],
  "name": "Local Ollama",
  "baseUrl": "http://127.0.0.1:11434/v1",
  "chatPath": "/chat/completions",
  "headers": { "X-Client": "norouter" },
  "models": ["llama3.3", "qwen2.5-coder"]
}
```

IDs and aliases are lowercase letters, digits, and dashes (max 40); model IDs permit letters, digits, `.`, `_`, `:`, `/`, `+`, `-` (max 120). URLs must be credential-free `http`/`https` URLs. Static headers are limited to 30 safe header names and values; `Authorization`, cookies, API keys, tokens, secrets, and related credential headers are rejected. Store credentials only in the account pool. Changing an ID atomically moves account and custom-model rows, then reindexes the live registry; old IDs/aliases stop resolving.

## Routing rules

| Method | Path | Notes |
|---|---|---|
| GET | `/api/routing-rules` | Read `{ routing, catalog, combos, keys }` |
| PATCH | `/api/routing-rules` | Update `{ aliases, rules }`; omitted fields are kept |

`routing` is `{ "aliases": { "<name>": "<model-or-combo>" }, "rules": [...] }`. `catalog` is the same enabled-model list the combo page uses, `combos` is the combo names, and `keys` is `{ id, name }` only — managed secrets are never returned here.

A rule is `{ id, name, enabled, match, models }`. `match` must hold at least one of:

- `header`: `{ "name": "x-route-tier", "value": "premium" }` — case-insensitive substring match on the request header.
- `apiKeyId`: a managed key id; matches only requests authenticated by that key while `REQUIRE_API_KEY` is on.
- `minContextTokens`: estimated `characters/4` plus 1,000 tokens per image.
- `hasTools`: whether the request carries at least one tool.

Rules are stored in order and the first enabled match wins; matching conditions are ANDed. Validation rejects an empty `match`, an unknown condition or rule field, an unknown API key id, duplicate models within a rule, duplicate rule names (case-insensitively), and any target that does not resolve. An enabled rule needs at least one model; a disabled draft may keep an empty list. Aliases (at most 50) may target a model or an existing combo but not another alias, rules (at most 20, 20 models each) may only target models, and neither may shadow a real model or combo name. Saving stores both lists canonically and assigns ids to new rules; omitted fields keep their current value.

Request precedence and the routing trace are documented in [`openai.md`](openai.md#aliases-routing-rules-and-per-key-defaults).

## Models

| Method | Path | Notes |
|---|---|---|
| POST | `/api/providers/:id/models` | `{ "model": "custom-id" }` |
| PATCH | `/api/providers/:id/models/:model` | `{ "enabled": true|false }`; disable keeps catalog row but removes routing/discovery |
| DELETE | `/api/providers/:id/models/:model` | custom models only |
| POST | `/api/providers/:id/models/fetch` | conventional `/models` discovery |
| POST | `/api/providers/:id/models/test` | one or all built-in/custom models |

Test one:

```json
{ "model": "glm-5.3", "disableOnError": false }
```

Test all:

```json
{ "all": true, "disableOnError": true }
```

The model-test prompt is fixed:

```text
Hi, what your model AI ? and your training cut off ?
```

Success result includes a bounded `answer`, `latencyMs`, and public masked account. Dashboard shows answer in a closeable bottom-right toast. Error result includes safe error/status. Only `disableOnError=true` disables the account used by a failed test. No raw token is returned.

## Accounts

| Method | Path | Notes |
|---|---|---|
| GET | `/api/providers/:id/accounts` | paginated list |
| GET | `/api/providers/:id/accounts/quota-list?page=1&pageSize=5` | quota-order cache list; known quota accounts first |
| POST | `/api/providers/:id/accounts/quota-order/refresh` | explicitly scan pool and refresh global quota ordering |
| POST | `/api/providers/:id/accounts` | one or bulk import |
| POST | `/api/providers/:id/accounts/preview` | non-mutating preview |
| PATCH | `/api/providers/:id/accounts/:accountId` | label, enabled, token replacement, clear cooldown |
| DELETE | `/api/providers/:id/accounts/:accountId` | delete account |
| POST | `/api/providers/:id/accounts/:accountId/test` | credential/quota probe |
| POST | `/api/providers/:id/accounts/:accountId/quota` | quota only |
| POST | `/api/providers/:id/accounts/:accountId/checkin` | Claim CodeBuddy daily check-in with an OAuth access/refresh-token account |
| POST | `/api/providers/:id/accounts/:accountId/ping` | one real chat turn; returns the upstream answer |
| POST | `/api/providers/:id/accounts/:accountId/warmup` | probe one parked account whose cooldown expired |
| POST | `/api/providers/:id/accounts/:accountId/restart` | pause then resume one account; clears cooldown and last error without an upstream probe |
| POST | `/api/providers/:id/accounts/test` | provider-native probe across every enabled account, sequentially |
| POST | `/api/providers/:id/accounts/warmup` | probe parked accounts with expired cooldowns; healthy accounts are untouched |
| POST | `/api/providers/:id/accounts/checkin` | daily check-in for every enabled OAuth account; API keys and paused rows are skipped |

List query:

```text
?page=1&pageSize=20&q=label-or-uid&status=all|active|cooldown|error|disabled
```

Import accepts an object, array, or wrapper:

```json
{ "accounts": [
  { "label": "Laptop", "access_token": "<TOKEN>" },
  { "kind": "refresh_token", "refresh_token": "<REFRESH_TOKEN>", "uid": "<UID>" }
] }
```

Supported aliases include `accessToken/access_token`, `refreshToken/refresh_token`, `apiKey/api_key`. `uid` and `plan` are accepted on any entry; `plan` is normalized to `free`, `plus`, `pro`, `ultra`, `team`, `business`, `enterprise`, or `unknown` (an unrecognized value becomes `unknown`). Max 5,000 rows; request body max 8 MiB. Bulk import uses one transaction. Duplicate response is 409 for a single duplicate and counts duplicate rows for bulk. An entry is a duplicate when its token fingerprint is already stored, or when its `(provider, uid)` identity already exists: OAuth re-login rotates the token but not the identity. Two entries carrying the same identity in one paste collapse to one row.

Daily check-in returns `{ "checkin": { "status": "checked-in"|"already"|"inactive", "message": "..." }, "account": { ... } }`. API-key accounts are rejected locally; refresh-token accounts refresh first. It does not increment proxy request or token counters. Account objects remain masked.

Pool-level `checkin` sweeps the whole pool sequentially and returns `{ "provider", "attempted", "checkedIn", "already", "failed", "skipped", "results": [{ "account", "ok", "status", "reason"?, "message"? }] }`. API-key rows and paused accounts are skipped, not failed: their rows carry `status: "skipped"` or `"disabled"` with a reason, and `skipped` counts both. Result rows are keyed by account label — no internal ID or token is returned.

Per-account `ping` sends one real streaming chat turn with a fixed minimal prompt and returns `{ "ok": true, "answer", "state": "active", "latencyMs", "account" }`. `answer` is the upstream reply truncated to 80 characters and `account` is masked; the turn counts toward the account's usage like any proxied request. A paused account returns 409, an unknown account 404, and upstream failure returns `{ "error": { "message", "type": "invalid_request_error" } }` with the provider's status.

`warmup` is recovery, not a health check: the pool-level route probes only parked accounts (`last_error` set) whose cooldown has expired and returns `{ "attempted", "recovered" }`; healthy accounts never reach the upstream quota endpoint. The per-account route does the same for one account and returns `{ "provider", "ok", "account", "quota" }` on success, `{ "ok": false, "skipped": true }` when there is nothing to warm, and `{ "ok": false, "status", "error" }` when the probe fails. Exhausted quota stays parked.

Quota ordering is process-memory-only and begins as unknown after restart. A per-account quota read updates its order. `quota-order/refresh` is an explicit full-pool upstream scan, concurrency-limited to three; use it when current global ordering matters. Neither endpoint returns credentials.

Preview response:

```json
{
  "provider": "codebuddy-cn",
  "total": 2,
  "fresh": 1,
  "duplicates": 1,
  "invalid": 0,
  "items": [
    { "index": 0, "label": "Laptop", "kind": "access_token", "masked": "abcd••••wxyz", "status": "new" },
    { "index": 1, "label": "Old", "kind": "access_token", "masked": "efgh••••stuv", "status": "duplicate" }
  ],
  "truncated": 0
}
```

Statuses: `new`, `duplicate`, `duplicate_input`, `invalid`. Preview does not write SQLite. Display rows are capped at 200; aggregate counts cover all input. Raw secrets and fingerprints are never returned.

## Provider OAuth

Browser login is provider-specific and only exists for the shipped providers that declare an OAuth block. States are short-lived and process-memory-only.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/providers/codex/oauth/start` | returns `{ authorizeUrl, state, callbackUrl }`; opens the PKCE callback server on port 1455 |
| GET | `/api/providers/codex/oauth/status/:state` | `{ status: "unknown"\|"pending"\|"complete"\|"error" }` |
| POST | `/api/providers/codex/oauth/cancel/:state` | `{ cancelled: true }` |
| POST | `/api/providers/codex/oauth/complete` | body `{ redirectUrl }`; redeems the pasted callback link, returns `{ status: "complete" }` |
| POST | `/api/providers/antigravity/oauth/start` | returns `{ authorizeUrl, state, callbackUrl }`; opens the fixed callback on port 1456 |
| GET | `/api/providers/antigravity/oauth/status/:state` | `{ status: "unknown"\|"pending"\|"complete"\|"error" }` |
| POST | `/api/providers/antigravity/oauth/cancel/:state` | `{ cancelled: true }` |
| POST | `/api/providers/antigravity/oauth/complete` | body `{ redirectUrl }`; redeems the pasted callback link, returns `{ status: "complete" }` |

The `complete` endpoint is the fallback for a browser that cannot reach the loopback callback, for example when the dashboard runs on another machine. It accepts only an `http` loopback URL (`127.0.0.1`, `localhost`, `::1`) on the provider's fixed port and exact callback path, and the `state` must still be pending. It consumes that state once and runs the same exchange and save path as the callback. The authorization code, tokens, and pasted URL are never returned or logged.

Antigravity start fails closed with 409 when `ANTIGRAVITY_CLIENT_ID` or `ANTIGRAVITY_CLIENT_SECRET` is missing, or when port 1456 is in use; it never embeds a client secret. A completed login creates an account bound to the Cloud Code `project_id`, and the dashboard polls `status` until `complete`. Neither flow returns tokens in the status response.

Both OAuth callbacks reuse the row for an identity that is already pooled instead of adding a second account: Codex reads `chatgpt_account_id` from the login JWT, Antigravity reads the Google email, and the callback refreshes that row's tokens, plan, and project binding in place.

## Account response safety

Public account objects expose IDs, label, kind, uid, masked value, token-presence booleans, state, expiry/cooldown, counters, the normalized `plan` tier, and timestamps. They do not expose access token, refresh token, API key, or fingerprint.

## Status codes

- `200`: read/update/test success.
- `201`: create/import success.
- `400`: invalid body/field/model.
- `401`: provider credential rejected or missing `/v1` auth.
- `404`: unknown provider/account/model.
- `409`: duplicate single account or custom provider/model conflict.
- `429`: no usable pooled account, upstream rate limit after attempts, or an exhausted per-key daily budget (`type: "budget_error"`).
- `502`: upstream/provider failure.

## Scope warning

Admin API authentication, CSRF protection, audit log, and rate limiting are not implemented. Do not expose these endpoints directly to an untrusted network.
