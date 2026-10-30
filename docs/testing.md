# Testing

## Standard suite

```bat
npm test
```

The suite uses a throwaway SQLite path and local `test/stub-upstream.js`; it must not need a real credential.

## Local stub setup

The smoke suite starts the stub itself. For manual work:

```bat
rem terminal 1
set ELECTRON_RUN_AS_NODE=1
"%LOCALAPPDATA%\Programs\ZCode\ZCode.exe" test\stub-upstream.js 4599

rem terminal 2
set ELECTRON_RUN_AS_NODE=1
rem Add a fake access token through the provider account-pool API before testing chat.
set CODEBUDDY_CN_BASE_URL=http://127.0.0.1:4599/v2
set CODEBUDDY_CN_REFRESH_URL=http://127.0.0.1:4599/v2/plugin/auth/token/refresh
set CODEBUDDY_CN_QUOTA_URL=http://127.0.0.1:4599/v2/billing/meter/get-user-resource
"%LOCALAPPDATA%\Programs\ZCode\ZCode.exe" src\server.js
```

Use only fake fixture values. Never point a production `.env` at test overrides.

## Covered

- Model alias/bare resolution.
- SSE parsing, chunk boundaries, tool calls, reasoning, error frames.
- Health, dashboard, status, model catalog.
- Custom provider/model CRUD.
- Account pagination/search/masking/preview/import/rotation.
- Active-account model tests and disable-on-error.
- Refresh-token exchange and quota parsing.
- Rate-limit cooldown/failover.

## Manual production checklist

- `/health` returns `ok`.
- `/v1/models` lists expected provider/model IDs.
- One controlled non-stream request succeeds.
- One controlled stream request emits SSE.
- Account list shows only masked tokens.
- Preview duplicate/new/invalid statuses are correct.
- Model test uses active account and returns expected answer toast.
- Quota card is clearly labeled upstream versus local.
- No raw provider credential appears in API response, browser DOM, logs, screenshots, or git diff. Managed proxy API keys are intentionally available to the local API Keys dashboard.

## Known gaps

Automated tests do not fully cover API-key gate scope, CORS, timeout/disconnect, admin exposure, SSRF policy, database concurrency/migration failure, accessibility/visual layout, or production CodeBuddy compatibility. Treat these as release review items.
