# Proxy API

Admin endpoints for the proxy pool. They are not covered by `REQUIRE_API_KEY`; protect `/api/*` with the same firewall or reverse proxy as the rest of the dashboard. Provider credentials and full proxy URLs are never returned. `<id>` is a proxy or provider ID, URL-encoded.

Behaviour, URL grammar, and security notes are in [proxy.md](../proxy.md).

## Settings and pool

| Method | Path | Notes |
|---|---|---|
| GET | `/api/proxy` | Settings, masked pool, assignments, counters, and job snapshots |
| PATCH | `/api/proxy` | Merge settings; any subset of the fields below |
| POST | `/api/proxies` | Add one proxy from a URL or separate fields |
| PATCH | `/api/proxies/:id` | Set `enabled` and/or `label`; the URL is immutable |
| DELETE | `/api/proxies/:id` | Delete; pinned assignments for it become `global` |
| POST | `/api/proxies/:id/test` | Test one proxy synchronously (8 s budget) |
| POST | `/api/proxies/import` | Bulk import from text or a URL list, no testing |
| POST | `/api/proxies/test` | Background test job for all proxies or selected IDs |
| PUT | `/api/proxy/providers/:id` | Set one provider's `global`, `direct`, or `pinned` mode |
| POST | `/api/proxy/scrape` | Background scrape-and-validate job |

## `GET /api/proxy`

```json
{
  "settings": {
    "enabled": false,
    "strategy": "round-robin",
    "strict": false,
    "autoDisableAfter": 3,
    "scrape": { "auto": false, "intervalMinutes": 360, "limit": 120 }
  },
  "proxies": [
    {
      "id": "px_ab12cd34",
      "label": "office",
      "maskedUrl": "http://•••@203.0.113.10:8080",
      "protocol": "http",
      "host": "203.0.113.10",
      "port": 8080,
      "hasAuth": true,
      "source": "manual",
      "enabled": true,
      "status": "ok",
      "latencyMs": 182,
      "failCount": 0,
      "lastChecked": "2026-11-14T08:00:00.000Z",
      "lastError": null,
      "createdAt": "2026-11-14T07:00:00.000Z",
      "updatedAt": "2026-11-14T08:00:00.000Z"
    }
  ],
  "assignments": {
    "codex": { "mode": "direct", "proxyId": "" }
  },
  "providers": [{ "id": "codex", "name": "Codex", "prefix": "cx" }],
  "stats": {
    "proxied": 0,
    "fallbackDirect": 0,
    "failures": 0,
    "lastError": null
  },
  "scrape": {
    "running": false,
    "startedAt": null,
    "finishedAt": null,
    "tested": 0,
    "passed": 0,
    "added": 0,
    "failed": 0,
    "duplicates": 0,
    "error": null,
    "sources": []
  },
  "testing": {
    "running": false,
    "startedAt": null,
    "finishedAt": null,
    "tested": 0,
    "ok": 0,
    "failed": 0
  }
}
```

`maskedUrl` is `scheme://•••@host:port` when the row stores credentials, otherwise `scheme://host:port`. `status` is `unchecked`, `ok`, or `fail`. `source` is `manual`, `import`, or `scrape`. A job snapshot is always present; `running: false` with null timestamps means none has run since start.

## `PATCH /api/proxy`

Merges settings. Omitted fields keep their value.

```json
{
  "enabled": true,
  "strategy": "random",
  "strict": false,
  "autoDisableAfter": 3,
  "scrape": { "auto": true, "intervalMinutes": 360, "limit": 120 }
}
```

Validation:

- `enabled`, `strict`, and `scrape.auto` must be booleans.
- `strategy` is `round-robin` or `random`.
- `autoDisableAfter` is an integer `0`–`100`; `0` disables automatic benching.
- `scrape.intervalMinutes` is an integer `30`–`10080`.
- `scrape.limit` is an integer `10`–`1000`.

A malformed or out-of-range value returns `400` and changes nothing. Turning the master switch on with an empty pool is accepted; with `strict` on, requests then fail with `502 proxy_unavailable` until a proxy is added or the switch is turned off.

## Adding a proxy

`POST /api/proxies` accepts one of two shapes:

```json
{ "url": "socks5://user:pass@203.0.113.10:1080", "label": "office", "test": true }
```

```json
{
  "protocol": "socks5",
  "host": "203.0.113.10",
  "port": 1080,
  "username": "user",
  "password": "pass",
  "label": "office",
  "test": true
}
```

`test` defaults to `true`. The row is stored even when the immediate test fails; the response carries the test result. `201` returns the masked row plus:

```json
{
  "proxy": { "id": "px_ab12cd34", "maskedUrl": "socks5://•••@203.0.113.10:1080" },
  "test": { "ok": true, "latencyMs": 244, "status": 204, "error": null }
}
```

Errors:

- `400` for an invalid URL, missing field, unsupported scheme, a SOCKS4 password, or a non-numeric port.
- `409` when the canonical URL already exists; the message names the existing masked URL and ID.

A test accepts any HTTP response as reachable, including `4xx` and `5xx`. The stored `status` becomes `ok` or `fail`, and a successful test resets `failCount` to `0`.

## Updating and deleting

`PATCH /api/proxies/:id`:

```json
{ "enabled": false, "label": "backup" }
```

Only those two fields are accepted. `label` is trimmed to 80 characters; an empty label falls back to `host:port`. Sending `url` or any transport field returns `400`; delete and re-add to change the endpoint. `404` for an unknown ID.

`DELETE /api/proxies/:id` returns `{ "deleted": true, "id": "px_ab12cd34" }`. Any `pinned` assignment pointing at that proxy is rewritten to `{ "mode": "global", "proxyId": "" }`, so a deleted proxy cannot leave a provider stranded on a missing target.

## Testing

`POST /api/proxies/:id/test` runs one tunnel test and waits for it. Response:

```json
{ "ok": false, "latencyMs": null, "status": 407, "error": "auth_failed" }
```

`error` is a short code (`timeout`, `connect_failed`, `auth_failed`, `tunnel_refused`, `tls_failed`), never a URL or credential. A proxy that returns target HTTP `500` is reachable and counts as `ok`; `407` from an HTTP proxy is an authentication failure.

`POST /api/proxies/test` starts a background job:

```json
{ "ids": ["px_ab12cd34"] }
```

An empty body or `{}` tests every proxy. Returns `202` with the current job snapshot. One test job runs at a time; a second request returns `409` with the active snapshot. Progress and results are read from `GET /api/proxy` under `testing`. Concurrency is 8 with an 8 second budget per proxy; every test updates the row.

## Import

`POST /api/proxies/import`:

```json
{ "text": "203.0.113.10:8080\nsocks5://user:pass@203.0.113.11:1080\n" }
```

or

```json
{ "urls": ["http://203.0.113.10:8080", "socks4://203.0.113.11:1080"] }
```

Accepted input is a JSON array, newline-separated text, or a mix of canonical URLs and `host:port` (stored as `http`). Blank lines and `#` comments are skipped. At most 5000 candidates per call; a larger input returns `400`. No network testing is performed. Response:

```json
{ "added": 2, "duplicates": 1, "invalid": 0, "total": 3 }
```

Invalid values are counted only. They are never echoed, because the input may contain credentials. Rows already in the table are counted as duplicates, not errors. The whole batch is inserted in one transaction.

## Provider assignment

`PUT /api/proxy/providers/:id`:

```json
{ "mode": "pinned", "proxyId": "px_ab12cd34" }
```

- `mode`: `global`, `direct`, or `pinned`.
- `pinned` requires an existing, enabled proxy ID; otherwise `400`.
- `global` and `direct` ignore `proxyId` and store an empty string.
- `404` when the provider ID is not in the registry.

Returns the full assignments map. Provider IDs are the routable IDs from `/api/status` (for example `codebuddy-cn`, `codex`, `antigravity`, or a custom provider ID).

## Scrape

`POST /api/proxy/scrape`:

```json
{
  "sources": ["proxifly", "monosans", "thespeedx", "geonode"],
  "limit": 120
}
```

Both fields are optional; defaults are all four sources and `settings.scrape.limit`. `limit` is clamped to `10`–`1000`; an unknown source returns `400`. Returns `202` with the scrape job snapshot. One scrape runs at a time; a second request returns `409` with the active snapshot. The job fetches source lists directly, deduplicates candidates, validates each through a real tunnel against a `204` endpoint, and stores only passes. Progress and the final summary are read from `GET /api/proxy` under `scrape`; the summary contains counts and per-source status only.
