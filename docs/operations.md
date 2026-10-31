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

`norouter.cmd` is the Windows launcher. On Linux, use `norouter` after `npm link`, or `node bin/norouter.js <command>` from the checkout. `npm start`, `npm run dev`, and `npm test` remain supported.

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

`/v1/models` needs the router API key only when `REQUIRE_API_KEY=true`. During chat, rate-limited, rejected, or failed accounts are parked temporarily and the router tries every remaining healthy account. It stops only after no healthy account remains or the request itself is invalid.

## Logs

Request logs are enabled unless `ENABLE_REQUEST_LOGS=false`. Logs include method, path, status, and duration, not request bodies. Upstream/error messages may still include sensitive operational context; do not publish logs without review.

## Database backup

Stop server for a simple backup. Copy `data/norouter.db`, `data/norouter.db-wal`, and `data/norouter.db-shm` together when present, or use an SQLite-aware backup. Database contains plaintext access/refresh tokens.

## Account backup & restore

Settings > General > "Backup & restore" exports just the account pool to a `.json` file, and restores it later by merge. This is for migrating or keeping a copy of accounts without carrying the whole SQLite file.

- **Download accounts (.json)** writes a file containing `version`, `exportedAt`, and `accounts[]` with **plaintext** tokens. Keep it as secret as the database; never commit it, paste it, or upload it.
- **Restore accounts** reads that file (or any account array), merges by provider, and skips duplicates by fingerprint. It never deletes or overwrites existing accounts. Unknown provider IDs are skipped and counted.
- Restore is additive: to fully replace a pool, delete unwanted accounts first, then restore.
- The `.json` file does not contain dashboard passwords, managed API-key secrets, or `.env` values.

## Account warmup and false cooldown recovery

Norouter does not send a dummy chat prompt before every request. That would add latency and spend quota. Instead, when no usable account remains, it performs on-demand warmup only for enabled accounts whose cooldown has already expired but still carry a parked error.

- Warmup probes the provider quota/health endpoint, not the chat model.
- A successful probe clears the parked error and cooldown, then the original request uses the recovered account.
- Invalid credentials remain parked and are not retried in a loop.
- Probes are single-flight per account, so concurrent requests share one probe.
- Warmup does not increment chat request/token counters and never logs tokens, prompt text, or Authorization headers.
- Providers without a verified quota/health endpoint are not probed automatically.

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
7. Verify `/health`, `/api/status`, account count, provider model catalog, and one controlled chat test.

## Restart behavior

Global request history, uptime, and dashboard stats reset. SQLite accounts, custom providers/models, account counters, and daily usage persist.

## Production posture

This is a local gateway, not a hardened public service. Before any network exposure, add a reverse proxy with TLS, authentication for dashboard/admin APIs, network policy for custom provider URLs, rate limiting, CSRF protection, and secure secret storage.
