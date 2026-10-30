# Implementation status

## Implemented

- Dependency-free Node HTTP server.
- SQLite persistence with WAL and legacy JSON migration.
- CodeBuddy CN OpenAI-compatible chat provider.
- Manual SQLite account pool as the only upstream credential source.
- Round-robin account selection, cooldown, refresh-token exchange, pause/resume.
- Account pagination, bulk import, duplicate fingerprint, preview, masking.
- Provider/model dashboard CRUD and conventional model fetch.
- Active-account model test with diagnostic answer toast.
- CodeBuddy billing meter parser and per-account quota action.
- Dashboard themes, accents, splash, route/modal/toast transitions.
- In-memory global usage/activity stats.
- Managed API keys with custom/automatic secrets, expiry, request/token limits, and daily usage history.
- Local upstream stub and smoke suite at last verification.

## Deliberately absent

- OAuth auto-login, device-code polling, browser login.
- MITM root CA.
- Subscription credential reuse.
- Anthropic/Gemini translation.
- Multi-provider fallback.
- Admin API authentication/RBAC/audit log; dashboard page password is not admin API authentication.
- TLS, rate limiting, CSRF protection, SSRF allowlist.
- Persistent global request history.

## Known limitations

- Dashboard HTML may use an optional page password; `/api` remains unauthenticated.
- `REQUIRE_API_KEY` gates only `/v1`.
- CORS is unrestricted.
- SQLite credentials are plaintext at rest.
- Custom provider URLs accept arbitrary HTTP(S) destinations.
- Built-in model catalog is a repository snapshot.
- CodeBuddy quota body/host/fields are upstream-dependent.
- Dashboard visual/accessibility behavior is not fully automated.
- Stream error normalization differs between stream and non-stream paths.

## Research confidence

Mirai and related implementations corroborate CodeBuddy request streaming, rate-limit parsing, refresh behavior, and broad quota package field conventions. They do not create an official immutable billing contract. Norouter should not change quota formulas without a controlled real payload or stronger upstream evidence.
