# norouter

Gateway AI lokal OpenAI-compatible. Fase saat ini fokus pada **CodeBuddy CN** (Tencent), account pool SQLite, streaming SSE, dan dashboard vanilla tanpa dependency atau build step.

> Dokumentasi lengkap: [`docs/README.md`](docs/README.md)

## Install dan quickstart

Runtime:

- Node.js **22.5+** dengan built-in `node:sqlite` / `DatabaseSync`.
- Git untuk `norouter update`.
- Tidak ada dependency npm, bundler, atau build step.
- Node 24 telah diuji.

### Windows PowerShell

```powershell
git clone https://github.com/levanza1358/norouter.git
cd norouter
Copy-Item .env.example .env
npm link
norouter start
```

### Windows Command Prompt

```bat
git clone https://github.com/levanza1358/norouter.git
cd norouter
copy .env.example .env
npm link
norouter start
```

### Linux

```bash
git clone https://github.com/levanza1358/norouter.git
cd norouter
cp .env.example .env
npm link
norouter start
```

Isi credential provider secara manual lewat dashboard atau account API. Jangan commit `.env`, database, WAL/SHM, token, atau log.

Alamat default:

- Dashboard: `http://127.0.0.1:1463/`
- Client base URL: `http://127.0.0.1:1463/v1`

`npm link` membuat command `norouter` tersedia global dari checkout ini. Tanpa `npm link`, jalankan `norouter.cmd` di Windows atau `./norouter.cmd`/`node bin/norouter.js` sesuai platform.

### Lifecycle command

```text
norouter start      Start server dan dashboard
norouter restart    Restart server yang dikelola norouter
norouter stop       Stop server yang dikelola norouter
norouter update     Fetch + fast-forward dari GitHub, lalu restart jika perlu
norouter dev        Start dengan Node watch mode
norouter test       Jalankan smoke suite
norouter version    Tampilkan versi
```

`norouter update` hanya berjalan pada checkout Git dengan working tree bersih. Update memakai `git fetch --prune origin` dan `git merge --ff-only origin/<branch>`; merge konflik atau perubahan lokal tidak dipaksa. Jika server sedang berjalan melalui `norouter start`, update otomatis me-restart server setelah commit baru masuk.

Alternatif tanpa CLI: `npm start`, `npm run dev`, dan `npm test`. `run.cmd` tetap tersedia sebagai launcher Windows lama.

## Credential dan account pool

Sumber credential yang didukung:

1. Account pool dari dashboard/API, disimpan di SQLite lokal:
   - `access_token` (API key aliases are normalized into this field)
   - `refresh_token`

Token account dimasukkan manual oleh operator. Pool mendukung tiga strategi per provider — `round-robin` (default), `sequential`, dan `highest-quota` — plus cooldown saat rate limit, pause/resume, pagination server-side, duplicate fingerprint, bulk import hingga 5.000 row, dan preview sebelum konfirmasi. Strategi diatur di tab Accounts pada detail provider. API/UI hanya mengembalikan token masked; token mentah tidak boleh masuk response atau dokumentasi.

Refresh CodeBuddy memakai refresh token yang operator simpan di account pool. `.env` hanya menyimpan konfigurasi proxy, endpoint override untuk test, dan router API key; bukan credential upstream. Router **tidak** melakukan OAuth auto-login, device-code polling, browser login, MITM root CA, atau reuse credential subscription dari aplikasi lain.

SQLite default: `data/norouter.db`. Override dengan `NOROUTER_DB`.

## Chat

Streaming:

```bat
curl -N http://127.0.0.1:1463/v1/chat/completions ^
  -H "Content-Type: application/json" ^
  -d "{\"model\":\"cbcn/deepseek-v4.1-flash\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"halo\"}]}"
```

Non-streaming:

```bat
curl http://127.0.0.1:1463/v1/chat/completions ^
  -H "Content-Type: application/json" ^
  -d "{\"model\":\"cbcn/glm-5.3\",\"messages\":[{\"role\":\"user\",\"content\":\"halo\"}]}"
```

CodeBuddy upstream selalu menerima stream. Untuk client non-stream, router mengakumulasi SSE menjadi satu completion JSON.

Model dapat ditulis sebagai `cbcn/<model>`, `codebuddy-cn/<model>`, atau bare ID jika tidak ambigu. `GET /v1/models` mengembalikan prefixed dan bare ID.

## Endpoint ringkas

| Method | Path | Fungsi |
|---|---|---|
| GET | `/health` | Health check |
| GET | `/api/status` | Snapshot dashboard in-memory |
| GET | `/api/usage` | Riwayat usage persisten (`range=day\|week\|month\|all`) |
| GET | `/api-keys` | Halaman managed key untuk akses `/v1` |
| GET | `/api/providers/:id` | Detail provider, pool, quota lokal, models |
| POST | `/api/providers` | Buat custom OpenAI-compatible provider |
| DELETE | `/api/providers/:id` | Hapus custom provider |
| GET/POST | `/api/providers/:id/accounts` | List atau import account |
| POST | `/api/providers/:id/accounts/preview` | Preview duplicate/invalid tanpa write |
| PATCH/DELETE | `/api/providers/:id/accounts/:accountId` | Update atau hapus account |
| POST | `/api/providers/:id/accounts/:accountId/test` | Test account; CodeBuddy membaca quota jika endpoint quota tersedia |
| POST | `/api/providers/:id/accounts/:accountId/quota` | Baca upstream quota jika provider mendukungnya |
| POST | `/api/providers/:id/models` | Tambah custom model |
| DELETE | `/api/providers/:id/models/:model` | Hapus custom model |
| POST | `/api/providers/:id/models/fetch` | Fetch conventional `/models` |
| POST | `/api/providers/:id/models/test` | Test satu/semua model dengan prompt diagnostik |
| GET | `/api/auth/status` | Status login dashboard |
| POST | `/api/auth/login` | Login dashboard password |
| POST | `/api/auth/logout` | Logout dashboard |
| GET/PATCH | `/api/auth/settings` | Baca/ubah dashboard password enabled state |
| PATCH | `/api/auth/password` | Ganti password dashboard |
| GET | `/v1/models` | OpenAI-compatible model list |
| POST | `/v1/chat/completions` | OpenAI-compatible chat |

Detail request/response: [`docs/api/openai.md`](docs/api/openai.md) dan [`docs/api/admin.md`](docs/api/admin.md).

## Dashboard

- **Dashboard**: request, token, latency, error, activity, health, sparkline.
- **Providers**: provider cards dan custom provider.
- **Provider detail**: Accounts, Models, Quota.
- **Accounts**: pagination, search, status filter, pause/resume/delete, check account, bulk import. Provider credentials come only from this local SQLite pool.
- **Preview import**: mendeteksi duplicate existing, duplicate dalam paste, invalid row; confirm baru menulis SQLite.
- **Model test**: wajib memakai account active; test per model atau test all; opsi disable account saat error; jawaban prompt diagnostik muncul di toast kanan bawah yang dapat ditutup.
- **Usage**: riwayat request/token persisten di SQLite dengan tab Harian, Mingguan, Bulanan, dan All time; tiap tab menampilkan total, grafik bucket, dan breakdown per model. Bucket mengikuti timezone komputer server.
- **API Keys**: multiple managed keys, automatic/custom plaintext token, Show/Hide/Copy, edit/rotate, expiry, request/token limits, enable/disable/revoke, and daily usage history.
- **Settings**: light/dark/black dan accent violet/blue/teal/amber/rose di `localStorage` browser.

Splash screen, route transition, modal transition, dan toast menghormati `prefers-reduced-motion`.

## CodeBuddy CN

Production chat endpoint:

```text
https://copilot.tencent.com/v2/chat/completions
```

Refresh:

```text
https://copilot.tencent.com/v2/plugin/auth/token/refresh
```

Quota/resource:

```text
https://copilot.tencent.com/v2/billing/meter/get-user-resource
```

Parser quota membaca `data.Response.Data.Accounts[]`, membedakan refill cycle dan bonus package, lalu menghitung package usage. Availability dan format upstream tetap dapat berubah; lihat [`docs/providers/codebuddy-cn.md`](docs/providers/codebuddy-cn.md).

Catalog bawaan saat ini mencakup GLM, MiniMax, Hunyuan, Kimi, dan DeepSeek. Catalog adalah snapshot repository, bukan jaminan semua model aktif di setiap akun.

## Persistence

SQLite menyimpan:

- accounts dan credential token
- custom models
- custom providers
- per-account daily usage
- global usage history (`usage_hourly`) untuk halaman Usage
- metadata schema
- managed API keys (plaintext) and daily per-key usage history

Kartu live di dashboard dan `/api/status` tetap in-memory dan kembali nol saat proses restart. Halaman Usage membaca `usage_hourly` sehingga riwayatnya bertahan. Account counters dan custom configuration juga bertahan di SQLite. Database/WAL/SHM harus diperlakukan sebagai secret material.

## Struktur

```text
src/
  server.js                 HTTP server dan router
  config.js                 loader .env
  providers/                provider registry + CodeBuddy CN
  routes/                   chat, models, provider, account, status, dashboard
  lib/                      SQLite, account pool, SSE, quota, stats, validation
  dashboard/                page.html, styles.css, app.js

data/
  norouter.db               SQLite runtime state (local, ignored)

test/
  smoke.js                  end-to-end smoke suite
  stub-upstream.js          local SSE/refresh/quota stub

docs/
  README.md                 documentation index
  prd.md                    product requirements
  design.md                 architecture
  rules.md                  invariants
  api/                      public and admin API
  providers/                provider-specific behavior
  adr/                      architecture decisions
```

## Security boundary

Default bind `HOST=127.0.0.1`. Changing `HOST` exposes the service. `REQUIRE_API_KEY=true` protects only `/v1` routes with exact `Authorization: Bearer <ROUTER_API_KEY>` comparison; dashboard page password, `/api`, `/health`, dan assets tetap tidak terlindungi oleh gate tersebut. Dashboard password hanya gate HTML halaman, bukan admin API authentication. CORS saat ini unrestricted.

Jangan expose port ke jaringan tanpa reverse proxy/authentication/TLS dan hardening tambahan. OAuth auto-login, MITM CA, dan subscription credential reuse belum diimplementasikan dan tidak boleh diasumsikan tersedia.

## Testing

```bat
npm test
```

Untuk uji lokal tanpa credential upstream, lihat [`docs/testing.md`](docs/testing.md). Jangan menaruh token asli di fixture, log, screenshot, commit, atau issue.
