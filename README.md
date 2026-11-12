# NoRouter

A local, dependency-free Node server that sits between your OpenAI-compatible
clients and a pool of provider accounts you manage yourself. One `/v1` endpoint,
one dashboard, zero `node_modules` — everything runs on the Node standard
library (Node ≥ 22.5) with SQLite (`node:sqlite`) for persistence.

- **`/v1`** — OpenAI-compatible proxy (`/v1/chat/completions`, `/v1/models`,
  `/v1/embeddings`, image generation) that round-robins, cools down, and fails
  over across your account pool.
- **Dashboard** — account pool, per-account test/ping/check-in, usage charts,
  API keys, model combos, and settings at `http://127.0.0.1:5555/`.
- **Providers** — CodeBuddy CN (OAuth pool with quota + daily check-in), Codex
  (Responses API), and any custom OpenAI-shaped base URL.

## Quickstart

```cmd
noroute.cmd start        :: background server + dashboard (Windows; falls back to the ZCode Electron runtime)
node noroute_bin/norouter.js start   :: same thing, any OS
npm start                :: foreground server
```

Then open the dashboard at `http://127.0.0.1:5555/`, add accounts on the
Providers page, and point any OpenAI client at:

```
base URL  http://127.0.0.1:5555/v1
API key   any managed key from the API Keys page
model     codebuddy-cn/glm-5.3      (prefix form)  — or a bare model id
```

The full CLI: `start`, `stop`, `restart`, `dev`, `test`, `update`,
`install`, `autostart-on/off/status`, `uninstall` — run `node noroute_bin/norouter.js help`.

## Tests

```cmd
npm test
```

The smoke suite (104 tests) boots the real server in-process against a local
stub upstream, so it is hermetic: a temp SQLite file, no network, no
credentials. It is the executable spec — behavior changes start there.

## Layout

| Path | What lives there |
|---|---|
| `noroute_bin/norouter.js` | CLI entry (start/stop/autostart/update) |
| `noroute_src/server.js` | HTTP server and route table |
| `noroute_src/lib/` | Accounts, quotas, usage, masking, settings, DB |
| `noroute_src/routes/` | Admin API + dashboard + chat handlers |
| `noroute_src/providers/` | Provider adapters (CodeBuddy CN, Codex, custom) |
| `noroute_src/dashboard/` | Dashboard HTML/CSS and ES-module views |
| `noroute_test/` | Smoke suite + stub upstream |
| `noroute_docs/` | Design, API reference, ops, rules |
| `data/` | Runtime SQLite DB (gitignored — holds plaintext tokens) |

## Docs

- [Status](noroute_docs/status.md) — what is implemented, route by route
- [Admin API](noroute_docs/api/admin.md) — every `/api` endpoint
- [Design](noroute_docs/design.md) and [data model](noroute_docs/data-model.md)
- [Operations](noroute_docs/operations.md) and [troubleshooting](noroute_docs/troubleshooting.md)
- [Runtime rules](noroute_docs/rules.md) — invariants the code and tests keep
- [Contributing](noroute_docs/contributing.md) and [testing](noroute_docs/testing.md)

## Security posture

NoRouter is a **local tool**. The `/api` routes and dashboard are
unauthenticated by default (optional dashboard password aside), CORS is open,
and provider tokens are stored **plaintext** in the local SQLite file so the
pool can rotate them. Do not expose the port beyond `127.0.0.1` without putting
auth/TLS in front — see [security.md](noroute_docs/security.md) and the
[release checklist](noroute_docs/release-checklist.md).
