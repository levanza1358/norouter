# Runtime rules and invariants

## Credentials

- Provider account tokens never appear in API/UI output. Managed proxy API keys are stored plaintext and may be shown through the local API Keys dashboard.
- Mask long values as first four + `••••` + last four; short values as `••••••`.
- Account credentials are manually pasted by the operator into the SQLite account pool; `.env` is not an upstream credential source.
- No OAuth auto-login/device polling/browser login.
- Never use MITM root CA or credentials extracted from another subscription/app.

## Provider/model

- Built-in provider IDs/aliases are code-owned.
- Custom provider IDs: lowercase letters, digits, dashes, max 40 characters.
- Custom model IDs: allowed `[A-Za-z0-9._:/+-]`, max 120 characters.
- Custom providers require an HTTP(S) base URL and at least one model.
- Generic provider forwarding is OpenAI-shaped only.
- A bare model ID must be unambiguous.

## Account states

- `active`: enabled, cooldown expired, no last error.
- `cooldown`: enabled with future cooldown timestamp.
- `error`: enabled, cooldown expired, non-empty last error.
- `disabled`: explicitly paused.
- Model tests use active accounts only.
- Resume clears cooldown and last error.
- Delete removes account and its daily usage rows.

## Rotation and retry

- Round-robin advances when an account is selected.
- Cooldown/error/disabled accounts are skipped.
- Maximum chat attempts: 4.
- 401/403 may trigger one refresh/retry for a pooled account.
- 429 parks account using upstream retry hint, reset timestamp, or default 60 seconds.
- 400/404/500 do not rotate through other accounts by default.

## Import

- Import accepts object, array, or `{ accounts: [...] }`.
- Max import size: 5,000 rows and 8 MiB HTTP JSON body.
- Preview max display rows: 200; aggregate counts still cover all rows.
- Existing fingerprint = `duplicate`.
- Repeated fingerprint within same paste = `duplicate_input`.
- Invalid row is never imported.
- Preview does not write SQLite; final import remains atomic.

## Model test

- Request prompt: `Hi, what your model AI ? and your training cut off ?`.
- Request is streaming, even for test endpoint.
- Success returns bounded `answer`, model, latency, and masked account.
- Error returns safe error; no answer field is required.
- Test-only failure does not disable account.
- `disableOnError=true` disables only the account used by that failed test.

## Quota

- Local quota card counts router-relayed traffic and is in-memory.
- CodeBuddy upstream quota is a separate billing meter.
- Refill uses cycle fields; bonus uses plain capacity fields.
- Do not treat upstream parser as a guarantee of future upstream schema.
- Global usage history persists in `usage_hourly`; bucket keys use the server's local timezone, while `account_usage` and `api_key_usage` keep UTC day keys.

## Limits

- Account list default page size 20, max 200.
- Upstream chat timeout defaults to 300 seconds.
- CodeBuddy refresh/quota helper timeout defaults to 15 seconds.
- Model test timeout defaults to 30 seconds.
