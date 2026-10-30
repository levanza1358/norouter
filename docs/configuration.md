# Configuration

`.env` is loaded from the repository root. Existing process environment variables win. The loader supports simple `KEY=value`; no interpolation or inline-comment parsing. Quote removal works only when quotes surround the full value.

## Core

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `1463` | HTTP listen port |
| `HOST` | `127.0.0.1` | Bind address; loopback is safe default |
| `REQUIRE_API_KEY` | `false` | Gate `/v1` and `/v1/*` only |
| `ROUTER_API_KEY` | empty | Exact Bearer value when gate enabled |
| `ENABLE_REQUEST_LOGS` | enabled | Only exact `false` disables request logs |
| `UPSTREAM_TIMEOUT_MS` | `300000` | Chat upstream timeout |
| `NOROUTER_DB` | `data/norouter.db` | SQLite file path |

## Local traffic budget

| Variable | Meaning |
|---|---|
| `CODEBUDDY_CN_TOKEN_BUDGET` | Local dashboard budget; not upstream quota |

Provider credentials are entered manually through the dashboard/API and stored in the SQLite account pool. `.env` is not a provider credential source.

## Test-only overrides

| Variable | Meaning |
|---|---|
| `CODEBUDDY_CN_BASE_URL` | Replaces chat base URL |
| `CODEBUDDY_CN_REFRESH_URL` | Replaces refresh endpoint |
| `CODEBUDDY_CN_QUOTA_URL` | Replaces quota endpoint |
| `CODEBUDDY_CN_CHECKIN_URL` | Replaces daily check-in endpoint |

Keep all four empty outside controlled tests. They can redirect credential-bearing requests.

## Provider budget naming

For custom provider ID `<id>`, the local budget variable is `<ID>_TOKEN_BUDGET` after replacing non-alphanumeric characters with `_` and uppercasing. It affects only the dashboard local traffic bar.

## Managed API keys

Create keys from the dashboard at `/api-keys` or `POST /api/keys`. The dashboard generates an editable `nr_live_...` draft before saving; custom secrets are also accepted. Managed keys are stored as plaintext in SQLite so they can be shown, hidden, copied, and edited later. Optional expiry, request limits, token limits, and daily usage history are supported. Token limits accept integer counts or a dashboard-selected `K`, `M`, `B`, or `T` suffix, such as `1M` for 1,000,000 tokens. Selecting `None` disables token-limit input; request limits have a separate enable toggle. Treat the local database, WAL/SHM, backups, `/api`, and dashboard as secret-bearing admin surfaces. `PATCH /api/auth-settings` controls whether `/v1` requires a key. The legacy `ROUTER_API_KEY` remains accepted when configured.

The key gate protects only `/v1` and `/v1/*`; dashboard, `/api`, `/health`, and assets remain outside the gate.

## API-key gate

With `REQUIRE_API_KEY=true`, send:

```http
Authorization: Bearer <ROUTER_API_KEY>
```

The comparison is exact. Managed keys can also be created from `/api-keys` with optional custom/generated secrets, expiry, request limits, token limits, and daily usage history. The gate does not protect dashboard, `/api`, `/health`, or assets.

## Secrets

Never commit `.env`, `data/norouter.db`, WAL/SHM files, logs, screenshots, or real credential fixtures. Rotate any credential that enters a log, screenshot, issue, or public repository.
