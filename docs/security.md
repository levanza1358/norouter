# Security

## Trust model

Norouter assumes a single trusted local operator supplies provider credentials. It is not currently a multi-user or public service.

## Current exposure

- Default bind is `0.0.0.0`, so the service listens on all interfaces.
- Dashboard HTML can use an optional password gate; `/api` admin routes remain unauthenticated.
- `REQUIRE_API_KEY` gates only `/v1` routes.
- CORS is unrestricted (`*`).
- Account access/refresh/API-key values are stored plaintext in SQLite.
- Custom provider URLs can target arbitrary hosts, localhost/private networks, or plaintext HTTP.
- Test URL overrides can redirect credential-bearing calls.
- No TLS termination, rate limiting, CSRF protection, RBAC, or audit log exists.
- Autostart runs the local checkout as the current user; protect the account and repository permissions.
- Error/event content can contain upstream text; review logs before sharing.

These are current facts, not recommended production controls.

## Threats and mitigations

### Credential disclosure

Mitigations currently present:

- Public account objects mask token values.
- Fingerprints are SHA-256 and not returned.
- Model-test answer/error is bounded and token-redacted.
- `.env`, SQLite DB, WAL/SHM, logs, screenshots are ignored or must be kept local.

Remaining risk: browser form submission and local SQLite are trusted-boundary operations. Protect the host and filesystem.

### Admin route abuse

`/api/providers`, account CRUD, model CRUD, and quota/test routes are unauthenticated. With the default `0.0.0.0` bind, put a strongly authenticated reverse proxy in front, restrict firewall access, or set `HOST=127.0.0.1`.

### Router API key

`ROUTER_API_KEY` remains an exact legacy static Bearer value for `/v1`. Managed keys are stored as plaintext in SQLite so `/api-keys` can show, hide, copy, edit, disable, expire, limit, revoke, or rotate them. Treat the database, WAL/SHM, backups, dashboard, and `/api` as secret-bearing local-admin surfaces. The toggle protects only `/v1`; dashboard and `/api` remain unauthenticated and require firewall/reverse-proxy protection when the default `0.0.0.0` bind is used.

### SSRF and plaintext upstream

Custom provider URLs and endpoint overrides are operator-controlled but can point at internal services. Do not accept untrusted admin input. Prefer HTTPS and explicit network allowlists in any hardened deployment.

### Credential flow restrictions

Forbidden:

- automated OAuth login/device-code polling/browser login
- MITM root CA
- subscription credential reuse from other apps

Allowed sources are `.env` or manually pasted SQLite account-pool values. Refresh is explicit token exchange, not login automation.

## Incident response

1. Stop router.
2. Rotate/revoke exposed upstream credentials.
3. Remove credential-bearing `.env`, DB, logs, screenshots, and backups from sharing locations.
4. Replace account tokens and inspect custom provider URLs/overrides.
5. Review git history if a secret was committed; removal from working tree is insufficient.
6. Restart with `HOST=127.0.0.1` or a protected firewall/reverse-proxy boundary, then validate masked responses.

## Safe deployment baseline

- `HOST=0.0.0.0` only with firewall/reverse-proxy protection; use `HOST=127.0.0.1` for local-only deployment.
- Empty test overrides.
- Filesystem permissions restricted to operator.
- Reverse proxy/TLS/authentication before any remote access.
- Separate test DB from operator DB.
- No real credential fixtures.
