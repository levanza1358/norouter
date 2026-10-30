# Dashboard and admin API

These endpoints are local administration surfaces. They are **not** covered by `REQUIRE_API_KEY`; keep the server on loopback or add an external authentication boundary before network exposure. Provider credentials are managed in the SQLite account pool, not `.env`.

Dashboard password, when enabled, gates dashboard HTML pages only. `/api/*`, assets, and model/provider operations remain available to the local operator after the page session expires. This is intentionally not network authentication; keep `HOST=127.0.0.1`.

`<id>` and `<accountId>` are URL-encoded provider/account IDs.

## API keys

| Method | Path | Notes |
|---|---|---|
| GET | `/api/keys` | List key metadata including plaintext managed tokens for Show/Hide/Copy |
| POST | `/api/keys` | Create key; response includes plaintext `secret` |
| PATCH | `/api/keys/:id` | Update name, enabled, expiry, request/token limits |
| DELETE | `/api/keys/:id` | Revoke a managed key and its usage history |
| GET | `/api/keys/:id/usage?days=30` | Daily request/token history |
| POST | `/api/keys/:id/rotate` | Replace the token; raw replacement `secret` returns once |
| GET/PATCH | `/api/auth-settings` | Read or set `requireApiKey` for `/v1` |
| GET/PATCH | `/api/token-saver` | Read or set the dependency-free Ponytail prompt transform |

Token Saver defaults to `{ ponytail: { enabled: false } }`. PATCH accepts `{ ponytail: { enabled: boolean } }`. The transform only applies to Chat Completions requests with a `messages` array, and changes system instructions without changing user or assistant messages. RTK and Headroom are not included because they require an external proxy or dependency.

Managed keys are stored as plaintext in SQLite so the dashboard can show, hide, copy, and edit them. Create accepts `name`, optional custom `secret`, optional future `expiresAt`, `requestLimit`, and `tokenLimit`; token limits accept integer counts or compact suffixes `K`, `M`, `B`, and `T` (for example `1M` = 1,000,000 tokens); the dashboard exposes these as a unit dropdown; `None` disables token-limit input, and request limits use a separate enable toggle. Omitted limits are unlimited. Request limits count admitted chat requests; token limits count reported prompt plus completion tokens. The dashboard page may require its optional page password, but `/api` routes remain unauthenticated; keep the server on loopback and treat its database, WAL/SHM, and backups as secret material.

## Status/provider

| Method | Path | Notes |
|---|---|---|
| GET | `/api/status` | In-memory status snapshot, last 40 history rows and last 60 events |

## Combos

| Method | Path | Notes |
|---|---|---|
| GET | `/api/combos` | List combos with their ordered model lists |
| POST | `/api/combos` | Create `{ name, models: string[] }`; returns 201 |
| GET | `/api/combos/:id` | One combo |
| PATCH | `/api/combos/:id` | Update `name` and/or `models`; omitted fields are kept |
| DELETE | `/api/combos/:id` | Delete; returns 200 |

Validation is enforced at the HTTP boundary:

- `name` is required, at most 60 characters, must start with a letter or digit, may use letters, digits, `.`, `_` and `-`, and may **not** contain `/` (that form belongs to `provider/model`). Names are unique — a duplicate returns 409.
- `models` must be a non-empty array of non-empty strings. Every entry must resolve through the normal model resolver, so a combo can never be saved pointing at a model the router would reject. The array order is the fallback priority and is stored verbatim.

Errors use the shared `{ error: { message, type } }` shape: 400 for validation, 404 for an unknown id, 409 for a duplicate name.

Combo routing behavior (fallback statuses, streaming safety, attribution) is documented in [`openai.md`](openai.md#combos).
| GET | `/api/usage?range=day\|week\|month\|all` | Persistent usage report from SQLite |
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

Supported aliases include `accessToken/access_token`, `refreshToken/refresh_token`, `apiKey/api_key`. Max 5,000 rows; request body max 8 MiB. Bulk import uses one transaction. Duplicate response is 409 for single duplicate and counts duplicate rows for bulk.

Daily check-in returns `{ "checkin": { "status": "checked-in"|"already"|"inactive", "message": "..." }, "account": { ... } }`. API-key accounts are rejected locally; refresh-token accounts refresh first. It does not increment proxy request or token counters. Account objects remain masked.

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

## Account response safety

Public account objects expose IDs, label, kind, uid, masked value, token-presence booleans, state, expiry/cooldown, counters, and timestamps. They do not expose access token, refresh token, API key, or fingerprint.

## Status codes

- `200`: read/update/test success.
- `201`: create/import success.
- `400`: invalid body/field/model.
- `401`: provider credential rejected or missing `/v1` auth.
- `404`: unknown provider/account/model.
- `409`: duplicate single account or custom provider/model conflict.
- `429`: no usable pooled account or upstream rate limit after attempts.
- `502`: upstream/provider failure.

## Scope warning

Admin API authentication, CSRF protection, audit log, and rate limiting are not implemented. Do not expose these endpoints directly to an untrusted network.
