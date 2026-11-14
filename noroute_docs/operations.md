# Operations

## Install/runtime

Requirements:

- Node.js 22.5+ with built-in `node:sqlite`.
- Git for `norouter update`.
- No npm dependency install is required.

Windows PowerShell:

```powershell
git clone https://github.com/levanza1358/norouter.git
cd norouter
.\install.ps1
```

Linux direct installer:

```bash
curl -fsSL https://raw.githubusercontent.com/levanza1358/norouter/main/install.sh | bash
```

The script clones into `~/norouter` by default. For an existing checkout, run `./install.sh`; set `NOROUTER_DIR=/path/to/norouter` for another location. The installer creates `.env` only when missing, preserves local state, links the CLI, and starts the managed server. Node.js 22.5+ remains required; it does not silently install system packages.

Commands:

```text
norouter start      server + dashboard di background; terminal boleh ditutup
norouter restart    restart managed server di background
norouter stop       stop managed server
norouter update     fast-forward from origin and restart if updated
norouter dev        server with --watch
norouter test       smoke suite
norouter version    package version
norouter install     create missing config and start server
norouter autostart-on  enable native autostart
norouter autostart-off disable native autostart
norouter autostart-status show native autostart status
norouter uninstall   confirm and remove this checkout
```

`noroute.cmd` is the Windows launcher. On Linux, use `norouter` after `npm link`, or `node noroute_bin/norouter.js <command>` from the checkout. `npm start`, `npm run dev`, and `npm test` remain supported.

`norouter update` requires a configured `origin`. If source changes are present, it saves them to a named Git stash automatically, then fast-forwards. It never resets, deletes, or overwrites local source changes. Ignored runtime data — `.env`, `config.local.json`, database/WAL/SHM — is not touched. Use `git stash list` and `git stash pop` only if you need to restore old source customization. A running managed server is restarted only after a new commit is installed.

`norouter autostart-on` uses Windows Task Scheduler or a Linux per-user `systemd` unit. Linux boot-time use may require `loginctl enable-linger <user>`. `norouter uninstall` stops only the managed process, removes norouter autostart, then asks for exact `y` or `yes`; confirmation deletes this checkout, `.env`, local config, and SQLite data. A non-interactive uninstall is refused.

## Start/stop

Default bind: `0.0.0.0:5555`. Access it at `http://<server-ip>:5555`. `norouter start` and `norouter restart` detach the managed server from the terminal; closing the terminal does not stop it. Use `norouter stop` to stop it. `norouter dev` remains foreground/watch mode. Change the port in Settings > General; norouter probes availability, persists the value in ignored `config.local.json`, and rebinds automatically. Set `HOST=127.0.0.1` for loopback-only use. `norouter stop` terminates only the PID marker created by a managed `norouter start`; it does not search for or kill unrelated Node processes. Ctrl+C remains supported for `norouter dev`. Graceful shutdown closes HTTP server and SQLite handle.

Because the default is `0.0.0.0`, configure the Ubuntu firewall/security group and set `REQUIRE_API_KEY=true` before remote use. Dashboard and `/api` admin routes remain unauthenticated; put an authenticated reverse proxy in front of them or bind `HOST=127.0.0.1`.

## Health checks

```bat
curl http://<server-ip>:5555/health
curl http://<server-ip>:5555/api/status
curl http://<server-ip>:5555/v1/models
```

`/v1/models` needs the router API key only when `REQUIRE_API_KEY=true`. It lists enabled models only: a model disabled from its provider page is omitted and cannot be routed until re-enabled. During chat, rate-limited, rejected, or failed accounts are parked temporarily and the router tries every remaining healthy account. It stops only after no healthy account remains or the request itself is invalid.

## Logs

Request logs are enabled unless `ENABLE_REQUEST_LOGS=false`. Logs include method, path, status, and duration, not request bodies. Upstream/error messages may still include sensitive operational context; do not publish logs without review.

A turn that stops early leaves a request log entry with status 502 and `Upstream stream ended before completion (provider/model)` or the upstream's own error message. Two stderr warnings separate the remaining cases without touching prompt or response text: `[chat] native tool-call marker left in content` (recovery could not parse an incomplete or unknown native call) and `[chat] empty completion` (the model genuinely returned no content and no tool call).

## Database backup

Stop server for a simple backup. Copy `data/norouter.db`, `data/norouter.db-wal`, and `data/norouter.db-shm` together when present, or use an SQLite-aware backup. Database contains plaintext access/refresh tokens and full proxy URLs.

## Account backup & restore

Settings > General > "Backup & restore" exports just the account pool to a `.json` file, and restores it later by merge. This is for migrating or keeping a copy of accounts without carrying the whole SQLite file.

- **Download accounts (.json)** writes a file containing `version`, `exportedAt`, and `accounts[]` with **plaintext** tokens. Keep it as secret as the database; never commit it, paste it, or upload it.
- **Restore accounts** reads that file (or any account array), merges by provider, and skips duplicates by fingerprint. It never deletes or overwrites existing accounts. Unknown provider IDs are skipped and counted.
- Restore is additive: to fully replace a pool, delete unwanted accounts first, then restore.
- The `.json` file does not contain dashboard passwords, managed API-key secrets, or `.env` values.

## Account warmup and false cooldown recovery

Norouter does not send a dummy chat prompt before every request. That would add latency and spend quota. Instead, when no usable account remains, it performs on-demand warmup only for enabled accounts whose cooldown has already expired but still carry a parked error.

- Warmup probes the provider quota/health endpoint, not the chat model.
- A successful probe with valid credentials and remaining quota clears the parked error and cooldown, then the original request uses the recovered account.
- A quota at 100% remains in `cooldown` until its reset; invalid or revoked credentials remain in `error` and are not retried in a loop.
- Probes are single-flight per account, so concurrent requests share one probe.
- Warmup does not increment chat request/token counters and never logs tokens, prompt text, or Authorization headers.
- Providers without a verified quota/health endpoint are not probed automatically.
- The provider detail page also has **Warmup all** for a manual recovery pass. It probes only expired parked accounts; active healthy accounts are left untouched.
- **Test all accounts** is separate: after confirmation, it sends one provider-native real request per enabled account. This can consume quota. `200` marks `active`; invalid credentials mark `error`; rate limits, exhausted quota, timeouts, and upstream failures mark `cooldown`. Paused accounts are skipped.
- Provider tests use each provider's wire format: CodeBuddy uses OpenAI-compatible streaming, Codex uses Responses format, and Antigravity uses the Cloud Code `v1internal` Gemini envelope. Automatic warmup never sends this real request.

## Daily budgets and scheduled upkeep

Settings → Daily budgets puts a token or cost cap on a managed API key or a whole provider. Limits live in the `meta.budgets` JSON snapshot; counters live in `budget_usage` under a local calendar day key, so every budget resets at the server machine's local midnight. Counters older than 90 days are pruned once per day. A cost cap is an estimate from the Usage page price table: unpriced models still count tokens but add zero cost, so a cost-only cap cannot see them.

- A key that reaches its cap returns 429 `budget_error` / `budget_exhausted` before any upstream call. A provider that reaches its cap is skipped by failover chains; the request continues on another target and only fails if none is left.
- When a scope crosses its limit, the webhook (if enabled) receives one `budget` event per scope per day with the limit, the used counters, and the reason (`tokens` and/or `cost`). No credential, prompt, or response text is included.
- Counters are written only for completed requests with usage, and only for scopes that had a limit at request time. Turning a limit off stops its counter but keeps the day's row visible in the card.
- Settings → Scheduled upkeep runs four background tasks while the server is up: token refresh (10 minutes), quota refresh (6 hours), Codex model catalog (12 hours), and proxy health (30 minutes, including an optional scheduled scrape). The scheduler interval defaults to 15 minutes and accepts 5–1440; the first automatic tick happens one full interval after start, so a restart does not fire upstream traffic immediately.
- Each tick only touches a bounded batch (20 token refreshes, 20 quota reads, 10 catalogs, 10 stale proxies) in oldest-first order, so a large pool is caught up over several ticks instead of one long burst.
- **Run all now** (or `POST /api/maintenance/run`) works even with the scheduler switched off, which is the way to verify credentials and catalog reads without waiting. A task that throws is reported in the card and webhook as an `error` event with `scope: "maintenance"`; the next tick retries.

## Proxy pool

`/proxy` manages optional data-plane egress. The master switch is off by default; with it off, every request goes direct and per-provider assignments are kept but unused. See [proxy.md](proxy.md) for URL grammar, transport, and security.

- **Add** one proxy manually (protocol/host/port/username/password or a pasted URL). Credentials are encoded by the form. The immediate test is optional; a failed test still stores the row so the failure is visible.
- **Import** up to 1000 lines or a JSON array. `host:port` is stored as `http`; duplicates are counted; invalid values are never echoed. Import does not test.
- **Scrape** is opt-in. Sources are fetched directly, candidates are deduplicated and capped, and each is validated through a real tunnel before storage. A public batch can yield zero usable proxies; treat free proxies as untrusted. One scrape runs at a time.
- **Test** checks one proxy against a target with an 8 second budget (or runs a background job for all/selected). Any HTTP response counts as reachable; `407` from an HTTP proxy is an authentication failure.
- **Assign** each provider to `global` (shared pool), `direct` (bypass), or `pinned` (one proxy). A missing entry means `global`.
- **Strict** makes an unavailable pool a `502 proxy_unavailable` instead of a direct fallback. Without it, an empty, benched, or failed pool falls back to direct and increments `fallbackDirect`.
- Health: a proxy whose `fail_count` reaches `autoDisableAfter` is benched (candidates exclude it). A successful test resets the count; `autoDisableAfter: 0` disables benching. A running server tests up to 10 enabled proxies with stale/null health every 30 minutes.
- OAuth refresh, quota, catalog fetch, and dashboard/admin traffic never use the pool.
- Logs contain short failure codes, never a proxy URL or credential. The database stores full proxy URLs, so it is as sensitive as the account table.

## Account names

New accounts without an explicit name are numbered from the provider's short prefix: `cbcn_1`, `cbcn_2`, and so on for CodeBuddy CN (`cx_1` for Codex, `ag_1` for Antigravity). The lowest unused number is reused, so deleting `_4` makes the next unnamed account `_4`. Names you type are kept exactly as entered. On startup, legacy automatic names (`Account · <uid>` and `<provider-id>_N`) are converted once to the short form; custom names are not touched. Rename an account from its row's **More → Edit name** action.

## Credential rotation

- Rotate upstream credentials immediately if exposed.
- Replace account token via account PATCH or delete/re-add account.
- Remove old `.env` fallback values and restart.
- Do not paste token values into issue trackers, docs, screenshots, or shell history.

## Upgrade

1. Stop process.
2. Back up SQLite state and `.env` separately.
3. Review `.env.example` changes.
4. Pull/copy code.
5. Start once so schema/legacy migration can run.
6. Run `npm test` in an isolated test environment.
7. Verify `/health`, `/api/status`, account count, provider model catalog, proxy pool state, and one controlled chat test.

## Restart behavior

Global request history, uptime, and dashboard stats reset. SQLite accounts, custom providers/models, account counters, proxy settings/rows/assignments, and daily usage persist. Proxy rotation cursor, job progress, and proxy counters reset.

## Production posture

This is a local gateway, not a hardened public service. Before any network exposure, add a reverse proxy with TLS, authentication for dashboard/admin APIs, network policy for custom provider URLs, rate limiting, CSRF protection, and secure secret storage.
