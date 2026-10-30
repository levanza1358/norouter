# norouter documentation

Norouter adalah gateway AI lokal OpenAI-compatible. Dokumentasi ini mengikuti implementasi repository saat ini.

## Baca berdasarkan kebutuhan

1. [PRD](prd.md) — tujuan, scope, non-goals, acceptance criteria.
2. [Design](design.md) — arsitektur dan lifecycle request.
3. [Rules](rules.md) — invariant yang harus dipertahankan.
4. [Configuration](configuration.md) — environment variables dan defaults.
5. [OpenAI API](api/openai.md) — `/v1/models` dan `/v1/chat/completions`.
6. [Admin API](api/admin.md) — dashboard/provider/model/account API.
7. [CodeBuddy CN](providers/codebuddy-cn.md) — endpoint, refresh, quota, model test.
8. [Custom providers](providers/custom.md) — batas dan validasi provider tambahan.
9. [Dashboard](dashboard.md) — screen dan workflow UI.
10. [Data model](data-model.md) — SQLite, persistence, migration.
11. [Operations](operations.md) — start, backup, upgrade, deployment.
12. [Testing](testing.md) — smoke suite dan local stub.
13. [Security](security.md) — exposure aktual dan safe deployment.
14. [Troubleshooting](troubleshooting.md) — diagnosis error umum.
15. [Status](status.md) — implementasi, gap, dan asumsi upstream.
16. [Release checklist](release-checklist.md) — pemeriksaan sebelum release.
17. [Contributing](contributing.md) — aturan perubahan.

Architecture decisions:

- [ADR-0001: Dependency-free Node + SQLite](adr/0001-runtime-and-sqlite.md)
- [ADR-0002: Authentication boundary](adr/0002-authentication-boundary.md)

## Source of truth

- Kode menentukan perilaku runtime.
- `test/smoke.js` menentukan behavior yang executable.
- Dokumen API hanya menjanjikan behavior yang sudah diuji atau terlihat jelas dari handler.
- PRD/design menjelaskan intent; bagian yang belum dibangun diberi label.
- Security docs menjelaskan exposure **saat ini**, bukan kontrol yang diinginkan.

## Status label

- **Implemented**: sudah ada di kode dan/atau smoke test.
- **Upstream-dependent**: parser/route ada, tetapi server upstream dapat berubah.
- **Not implemented**: belum ada; jangan dipakai sebagai asumsi.
- **Known limitation**: behavior aktif yang memiliki konsekuensi operasional.

## Credential policy

`no OAuth auto-login, no MITM root CA, no subscription credential reuse; provider credentials come only from the SQLite account pool.`

`.env` is reserved for proxy configuration, router authentication, local budgets, and controlled upstream endpoint overrides.

Tetap dilarang: automated OAuth flows/device-code polling/browser login, MITM root CA, dan reuse credential subscription dari aplikasi lain.

Provider account credentials remain masked. Managed proxy API keys are the exception: project policy stores them plaintext in SQLite and returns them to local `/api-keys` for persistent Show/Hide/Copy.
