# Proxy

NoRouter can send upstream **data-plane** traffic through an operator-managed proxy pool. A proxy is a network path, not a provider: it does not change wire formats, model resolution, account choice, budgets, or SSE relay. When no proxy is selected the request uses the global `fetch` exactly as before.

Scope is deliberately narrow. These calls may use a proxy:

- chat completions, Responses, and Anthropic Messages upstream calls;
- image generation;
- embeddings;
- model tests and account probes started from the dashboard.

These never use a proxy:

- OAuth token exchange and refresh;
- quota reads and daily check-in;
- provider model-catalog fetch;
- the dashboard, `/api/*`, `/health`, and inbound `/v1/*` handling itself.

The proxy feature is off by default. Enabling it is an explicit operator action.

## URL formats

One proxy is one URL:

```text
scheme://[user:password@]host:port
```

| Scheme | Transport | DNS for the target | Authentication |
|---|---|---|---|
| `http` | HTTP `CONNECT` | local resolver | optional Basic |
| `https` | TLS to the proxy, then `CONNECT` | local resolver | optional Basic |
| `socks4` | SOCKS4 | local resolver | optional user ID, no password |
| `socks4a` | SOCKS4a | proxy resolves the hostname | optional user ID, no password |
| `socks5` | SOCKS5 | local resolver, IP sent to the proxy | optional username/password |
| `socks5h` | SOCKS5 | proxy resolves the hostname | optional username/password |

`https://` means the connection to the proxy itself is wrapped in TLS before `CONNECT`. It does not mean the target is HTTPS; the target's own scheme is taken from the upstream URL. A target HTTPS request is wrapped in a second TLS handshake inside the tunnel.

Rules:

- The port is always explicit (`1`–`65535`). There is no default port.
- A host may be an IPv4 literal, a bracketed IPv6 literal, or a DNS name. A bare IPv6 address without brackets is rejected.
- Credentials are optional. Special characters in the username or password must be percent-encoded (`@`, `:`, `/`, `%`, and non-ASCII bytes). They are decoded once before the handshake.
- `socks4` and `socks4a` accept a user ID only. A password in the URL is rejected because the protocol has no password field.
- No path, query string, or fragment is allowed. One trailing `/` after the port is tolerated and stripped.
- Control characters, whitespace, backticks, and `$` are rejected. The maximum length is 2048 characters.
- A duplicate URL is rejected after normalisation (scheme and host lowercased, empty password collapsed). The same proxy is never stored twice.

Examples:

```text
http://203.0.113.10:8080
https://proxy.example.net:8443
http://user:p%40ss@203.0.113.10:3128
socks5://203.0.113.10:1080
socks5h://user:pass@proxy.example.net:1080
socks4a://203.0.113.10:1080
```

Invalid examples: `https://100.100.100.100:password` (no numeric port), `http://host` (missing port), `socks4://user:pass@host:1080` (password on SOCKS4), `http://host:8080/path`.

The dashboard's manual form takes protocol, host, port, username, and password as separate fields and assembles a correctly encoded URL. The paste mode accepts the canonical URL above.

## Storage

Proxies live in the `proxies` table. The `url` column holds the full credentials because they are needed to connect; it is never returned by an API or rendered in the dashboard. Every API response and UI row uses a masked form:

- `scheme://•••@host:port` when the URL carries credentials;
- `scheme://host:port` when it does not.

Settings live in `meta.proxy_settings`:

```json
{
  "enabled": false,
  "strategy": "round-robin",
  "strict": false,
  "autoDisableAfter": 3,
  "scrape": { "auto": false, "intervalMinutes": 360, "limit": 120 }
}
```

Per-provider assignments live in `meta.proxy_assignments`, keyed by provider ID:

```json
{
  "codebuddy-cn": { "mode": "global", "proxyId": "" },
  "codex": { "mode": "direct", "proxyId": "" },
  "custom-abc": { "mode": "pinned", "proxyId": "px_..." }
}
```

A provider with no entry uses `global`. Assignments to a provider that no longer exists are ignored, not deleted.

Runtime state — rotation cursor, active jobs, and counters — is in memory and resets on restart.

## Selection

One request resolves to exactly one of three modes:

1. If `proxy_settings.enabled` is `false`, every request is direct. Per-provider entries are kept but unused.
2. `direct` bypasses the pool for that provider.
3. `global` uses the shared pool. `pinned` uses the assigned proxy only.

Pool candidates are enabled proxies whose `fail_count` is below `autoDisableAfter`. Setting `autoDisableAfter` to `0` disables automatic benching, so only the `enabled` flag removes a proxy. A proxy can be re-enabled from its row, and any successful test resets its failure count.

Strategy:

- `round-robin` walks the candidate list in row order with an in-memory cursor. Restart resets the cursor.
- `random` picks a candidate at random per request.

A pinned proxy that was deleted, disabled, or benched is treated as unavailable for that provider.

## Transport

The transport is implemented with `node:net`, `node:tls`, and `node:http`; there is no dependency and no global dispatcher. Node's global `fetch` ignores a per-request proxy dispatcher in the supported runtime, and an environment proxy variable would be process-wide rather than per provider. The tunnel returns a normal `Response` object, so the existing SSE relay, buffering, and accumulator code is unchanged.

Connecting:

1. Open a TCP socket to the proxy. For `https://`, perform TLS to the proxy first.
2. For HTTP proxies, send `CONNECT host:port HTTP/1.1` with `Host` and optional `Proxy-Authorization: Basic`. Any `2xx` response opens the tunnel; anything else is a proxy failure.
3. For SOCKS5, negotiate methods, perform username/password authentication when selected, then send `CONNECT` with an IPv4, IPv6, or domain address. A non-zero reply code is a proxy failure.
4. For SOCKS4/4a, send the version-4 connect request; for `socks4a` use the `0.0.0.1` marker plus the hostname. A non-`0x5a` reply is a proxy failure.

After the tunnel opens, a target `http://` request is written over the socket in origin form. A target `https://` request is wrapped in TLS with the target host as SNI, then written the same way. Only `http` and `https` upstream URLs are accepted by this transport.

Request behaviour:

- Hop-by-hop headers and `Host` are normalised. `Proxy-Authorization` is never forwarded to the target. `accept-encoding` is set to `identity`.
- Redirects are followed up to five times. `307`/`308` replay the same method and a string or `Buffer` body; `303`, and `301`/`302` after a `POST`, become a bodyless `GET`. A non-replayable body stops at the redirect and returns the response.
- If the target ignores `identity` and compresses anyway, the body is decompressed with `node:zlib` and the `content-encoding`/`content-length` headers are removed from the returned `Response`.
- `AbortSignal` cancels connecting, handshaking, and an in-flight response body.
- Connection and handshake stages time out after 10 seconds each. The caller's request timeout and abort signal still apply.

Retry and failure semantics:

- A transport failure before any response headers allows one retry on a second distinct proxy from the same selection (global pool only). A pinned proxy gets one attempt.
- Any HTTP response from the target counts as a transport success, including `4xx` and `5xx`. Proxy rotation never retries an upstream HTTP error; existing account, retry, and fallback logic remains in charge.
- If every proxy attempt fails, the request falls back to a direct call unless Strict is on. In Strict mode it fails with HTTP `502`, `type: "proxy_error"`, `code: "proxy_unavailable"`. The error names no proxy URL or credential.
- A `proxy_unavailable` failure does not mark the provider account as failed or cooling; the account was never reached.
- Proxy failures increment `fail_count`, set `status: "fail"`, and store a short error code in `last_error` (`timeout`, `connect_failed`, `auth_failed`, `tunnel_refused`, `tls_failed`). A later success with a non-zero count resets the count and status without a write on every healthy request.

In-memory counters exposed on the Proxy page:

- `proxied` — requests that reached the target through a proxy;
- `fallbackDirect` — proxied selections that fell back to direct;
- `failures` — transport attempts that failed;
- `lastError` — the most recent short code and time, without a URL.

## Adding and importing

Three entry paths:

- **Manual** — protocol/host/port/username/password fields, or a pasted URL. Optionally test immediately. A failed test still stores the row, marked `fail`, so the operator can see what was rejected.
- **Import** — paste text or choose a file. Accepted lines are canonical URLs, `host:port` (stored as `http`), and a JSON array of either. Blank lines and `#` comments are skipped. Up to 5000 candidates per import, no automatic testing. Invalid values are counted, never echoed, because the input may contain credentials.
- **Scrape** — see below.

Adding a duplicate returns `409` with the existing masked row. A proxy URL is immutable: edit `label` or `enabled`, or delete and re-add it.

## Scraping free proxies

Scraping is **opt-in and off by default**. It is a feeder for the same pool, not a separate proxy type. Every candidate must pass a real tunnel test before it is stored, so a source returning dead hosts does not fill the table.

Built-in sources:

| ID | Source | Format |
|---|---|---|
| `proxifly` | proxifly/free-proxy-list | JSON per protocol (http, https, socks4, socks5) |
| `monosans` | monosans/proxy-list | text `host:port` per protocol |
| `thespeedx` | TheSpeedX/PROXY-List | text `host:port` per protocol |
| `geonode` | geonode proxy-list API | JSON list with protocols |

Source responses are fetched directly (the scraper must not depend on the pool it is filling), never with credentials. Candidates are deduplicated against the database and within the batch, interleaved across protocols, and capped by the configured limit (default 120, maximum 1000). Validation uses up to 24 concurrent tunnels with a 6 second timeout per candidate, targeting `https://www.gstatic.com/generate_204` and requiring `204`. Only passes are inserted with `source: "scrape"` and their measured latency; failures are dropped. The job summary reports tested/passed/added/duplicates/failed counts and per-source fetch status. It contains no proxy URLs, credentials, or target URLs.

Expectations: public free proxies are mostly dead, slow, or hostile. A batch can complete with zero usable rows. Manual or paid proxies are the reliable path; the scraper is best treated as a source of candidates to validate.

One scrape runs at a time. A second POST returns `409` and the active job's snapshot. In the dashboard, the scrape card shows progress and the last summary; the settings card can schedule a scrape automatically.

## Health upkeep

The maintenance scheduler gains a proxy task that runs every 30 minutes:

- when the master switch is on, test at most 10 enabled proxies whose `last_checked` is null or older than 6 hours, oldest first;
- when `scrape.auto` is on and `scrape.intervalMinutes` has elapsed since the last completed scrape, run one scrape with the configured limit;
- when the master switch is off and auto-scrape is off, the task does nothing.

The manual **Test** action always works, including with the master switch off, so a pool can be prepared before enabling it. A single test is synchronous with an 8 second budget and accepts any HTTP response as reachable; **Test all** runs as a background job.

## Security

A proxy sees the destination host and port, TLS SNI, request timing, and traffic volume. For `http://` targets it also sees the request and response body in plaintext, including the upstream `Authorization` header. For `https://` targets the tunnel is opaque unless the proxy presents a certificate the router trusts; NoRouter ships no custom CA and does not disable certificate verification. A hostile proxy can still block, delay, or replay traffic, and can return its own responses.

Mitigations in the implementation:

- default off; Strict is opt-in;
- data-plane scope only, so OAuth refresh, quota, catalog, and dashboard traffic stay direct;
- credentials masked in every API response, dashboard row, error, and log line;
- no proxy URL, username, password, or target URL in job summaries or webhook events;
- the proxy credential is sent only to the proxy (Basic or SOCKS auth), never forwarded to the target;
- free-proxy warnings in the page and in this document.

Do not enable a proxy pool on a host whose traffic policy forbids third-party egress. Do not enter a proxy you do not trust with the provider traffic it will carry.

## Persistence and reset

Persisted: proxy rows (including URLs), settings, assignments, `last_checked`, latency, failure counts, and the last scrape completion time.

Not persisted: rotation cursor, active test/scrape jobs, and the counters listed above. They reset on restart, like the rest of the live dashboard stats.

## Related

- [Proxy API](api/proxy.md)
- [Data model](data-model.md)
- [Security](security.md)
- [Operations](operations.md)
- [Dashboard](dashboard.md)
