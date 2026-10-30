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
Copy-Item .env.example .env
npm link
norouter start
```

Linux:

```bash
git clone https://github.com/levanza1358/norouter.git
cd norouter
cp .env.example .env
npm link
norouter start
```

Commands:

```text
norouter start      server + dashboard
norouter restart    restart managed server
norouter stop       stop managed server
norouter update     fast-forward from origin and restart if updated
norouter dev        server with --watch
norouter test       smoke suite
norouter version    package version
```

`norouter.cmd` is the Windows launcher. On Linux, use `norouter` after `npm link`, or `node bin/norouter.js <command>` from the checkout. `npm start`, `npm run dev`, and `npm test` remain supported.

`norouter update` requires a clean Git checkout and a configured `origin`. It never overwrites local changes or performs a non-fast-forward merge. A running managed server is restarted only after a new commit is installed.

## Start/stop

Default bind: `0.0.0.0:5555`. Access it at `http://<server-ip>:5555`. Change the port in Settings > General; norouter probes availability, persists the value in ignored `config.local.json`, and rebinds automatically. Set `HOST=127.0.0.1` for loopback-only use. `norouter stop` terminates only the PID marker created by a managed `norouter start`; it does not search for or kill unrelated Node processes. Ctrl+C remains supported. Graceful shutdown closes HTTP server and SQLite handle.

Because the default is `0.0.0.0`, configure the Ubuntu firewall/security group and set `REQUIRE_API_KEY=true` before remote use. Dashboard and `/api` admin routes remain unauthenticated; put an authenticated reverse proxy in front of them or bind `HOST=127.0.0.1`.

## Health checks

```bat
curl http://<server-ip>:5555/health
curl http://<server-ip>:5555/api/status
curl http://<server-ip>:5555/v1/models
```

`/v1/models` needs the router API key only when `REQUIRE_API_KEY=true`.

## Logs

Request logs are enabled unless `ENABLE_REQUEST_LOGS=false`. Logs include method, path, status, and duration, not request bodies. Upstream/error messages may still include sensitive operational context; do not publish logs without review.

## Database backup

Stop server for a simple backup. Copy `data/norouter.db`, `data/norouter.db-wal`, and `data/norouter.db-shm` together when present, or use an SQLite-aware backup. Database contains plaintext access/refresh tokens.

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
