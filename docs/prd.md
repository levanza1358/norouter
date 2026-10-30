# Product requirements

## Product

Norouter adalah gateway AI lokal yang menerima protocol OpenAI-compatible dan meneruskan request ke provider upstream. Fase aktif berfokus pada CodeBuddy CN, dengan dashboard operasional dan account pool SQLite.

## Users

- Operator lokal yang memiliki credential provider secara sah.
- Developer yang membutuhkan satu base URL untuk client OpenAI-compatible.
- Maintainer yang menambah provider/model tanpa menambah framework.

## Goals fase aktif

1. Menyediakan `/v1/models` dan `/v1/chat/completions`.
2. Meneruskan streaming SSE dan menggabungkan stream untuk client non-stream.
3. Mendukung CodeBuddy CN production endpoint dengan access token, refresh token manual, atau API key.
4. Menyimpan account pool dalam SQLite dengan round-robin, cooldown, pause/resume, pagination, duplicate detection, dan bulk import.
5. Menampilkan dashboard: Dashboard, Providers, Usage, Settings, dan detail provider.
6. Menyediakan model test dengan account active dan jawaban diagnostik di toast.
7. Menyediakan quota CodeBuddy CN berdasarkan billing meter yang tersedia.
8. Menyediakan test stub tanpa credential asli.

## Non-goals

- Anthropic/Claude translation.
- OAuth auto-login, device-code polling, browser login.
- MITM root CA atau interception credential dari tool lain.
- Reuse subscription credential yang ditarik dari aplikasi lain.
- Local admin authentication penuh.
- Admin authentication penuh, RBAC, audit log, TLS termination, rate limiting, CSRF protection.
- Multi-provider fallback atau cost optimizer.
- Guarantee bahwa catalog/model/quota upstream selalu sama.

## Acceptance criteria

- Local start default di `127.0.0.1:1463`.
- Client dapat memakai `/v1` dengan prefixed atau bare model ID yang tidak ambigu.
- Raw access/refresh/API keys tidak pernah muncul dalam API response/UI.
- Preview import tidak mengubah SQLite.
- Confirm import atomic untuk bulk.
- Model test menolak saat tidak ada account active.
- Error model test tidak men-disable account kecuali mode disable-on-error dipilih.
- `npm test` pass.
- Dokumentasi tidak menjanjikan fitur non-goal sebagai fitur aktif.

## Success signals

- Request berhasil diteruskan dengan latency dan error yang terlihat.
- Operator dapat menambah 100–5.000 account tanpa browser merender seluruh pool.
- Rate-limited account diparkir tanpa retry loop.
- Diagnosis credential/model/upstream dapat dilakukan dari dashboard dan logs.

## Candidates, bukan komitmen

- Admin authentication di luar `/v1`.
- TLS/reverse proxy deployment guide yang hardened.
- Persistent request history.
- Multi-provider routing/fallback.
- Provider-specific quota cache dan request history.
- Automated accessibility/visual tests.
