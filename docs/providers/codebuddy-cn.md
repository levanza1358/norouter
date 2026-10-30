# CodeBuddy CN provider

## Identity and chat

- Provider ID: `codebuddy-cn`
- Aliases: `cbcn`, `codebuddy`
- Website: `https://copilot.tencent.com`
- Format: OpenAI-compatible
- Production chat: `POST https://copilot.tencent.com/v2/chat/completions`
- CodeBuddy upstream requires streaming; Norouter forces `stream: true` upstream.

Fixed headers include CLI-style `User-Agent`, `X-Product: SaaS`, `X-IDE-Type: CLI`, `X-IDE-Name: CLI`, `x-requested-with`, and `x-codebuddy-request`.

## Credential forms

- Access token/API key: stored manually in the SQLite account pool and sent as `Authorization: Bearer <operator-supplied-value>`.
- Refresh token: stored manually in the account pool and exchanged when access token is absent/near expiry.
- `.env` is not an upstream credential source.

No OAuth login, state polling, browser login, or device-code automation is implemented.

## Refresh

```text
POST https://copilot.tencent.com/v2/plugin/auth/token/refresh
```

Body `{}`. Refresh token goes in `X-Refresh-Token`. Other provider headers include `X-Domain: copilot.tencent.com`, `X-Auth-Refresh-Source: plugin`, and `X-Product: SaaS`. A successful response is expected to contain `code: 0`, `data.accessToken`, optional `data.refreshToken`, and `data.expiresIn`.

Refresh helper timeout: 15 seconds. Concurrent refreshes for one account are deduplicated.

## Quota/resource

```text
POST https://copilot.tencent.com/v2/billing/meter/get-user-resource
```

Norouter currently sends `{}` with Bearer token and parses:

```text
data.Response.Data.Accounts[]
```

Refill rows use `CycleCapacityUsed*`/`CycleCapacitySize*`; bonus rows use `CapacityUsed*`/`CapacitySize*`. A row is classified as refill when `DeductionEndTime - CycleEndTime > 2 days`. Refill reset uses `CycleEndTime`; bonus is displayed as expiring package. This is based on observed/public implementations and remains upstream-dependent.

Related CodeBuddy rate-limit signals include code `6004`, `frequency limit`, `超出频率限制`, or `限额`; chat retry uses `Retry-After` or a parsed timestamp when available.

Quota endpoint, host routing, request body, headers, and fields may vary by product/region/version. Do not treat this parser as an official immutable contract. See `docs/status.md` for confidence boundaries.

## Daily check-in

```text
POST https://www.codebuddy.cn/v2/billing/meter/daily-checkin
```

The Accounts table provides a per-account **Check in** action. It accepts OAuth access-token accounts and refresh-token accounts after refresh. API-key accounts are rejected locally, before any upstream request. The request sends `{}` with Bearer access token, `X-User-Id` from JWT `sub` or stored account UID, and observed CodeBuddy web headers. Results distinguish `checked-in`, `already`, and `inactive`; check-in does not count as proxied traffic. This reverse-engineered endpoint is separate from the `copilot.tencent.com` chat/quota host and may change upstream.

## Model catalog snapshot

```text
glm-5.3
glm-5.3-flash
glm-5.2
glm-5.1
minimax-m3
hy3
hy4-preview
kimi-k3-1
kimi-k2.8-preview
deepseek-v4-pro
deepseek-v4.1-flash
```

Catalog is bundled metadata. CodeBuddy CN has no supported upstream `/models` route, so the dashboard disables `Fetch from provider` and shows `Catalog bundled`. Edit the provider catalog or add custom models when the upstream model set changes.

## Model capabilities

The dashboard shows local capability metadata for CodeBuddy models: text, vision, reasoning, thinking switchability, context window, and max output tokens. Values come from Mirai's local CodeBuddy capability mirror and are labeled `verified-local`; they are not an immutable Tencent API contract. PDF is shown as `inferred` from vision support. JSON/structured output is `unknown` because no CodeBuddy declaration or probe verifies it. Custom providers and models without a registry entry remain `unknown` rather than inheriting CodeBuddy values.

CodeBuddy reasoning uses the OpenAI-style `reasoning_effort` wire format. Capability metadata does not prove every input type is accepted by every upstream route; test the provider before relying on PDF or structured output.

CodeBuddy also puts `"tool_calls": []` on ordinary reasoning and content deltas. Norouter removes that empty array on the streaming relay for every provider; otherwise OpenAI-compatible SDKs treat each delta as a tool-call frame and split one chain of thought into many tiny reasoning blocks.

## Model test

Dashboard/API model test sends:

```text
Hi, what your model AI ? and your training cut off ?
```

It uses a selected active account and a streaming request. Successful answer is bounded/redacted server-side, returned as `answer`, and shown in a dismissible toast. Test-only failure leaves account state unchanged unless disable-on-error is explicitly requested.

## Test overrides

For local stub only:

```text
CODEBUDDY_CN_BASE_URL=http://127.0.0.1:<PORT>/v2
CODEBUDDY_CN_REFRESH_URL=http://127.0.0.1:<PORT>/v2/plugin/auth/token/refresh
CODEBUDDY_CN_QUOTA_URL=http://127.0.0.1:<PORT>/v2/billing/meter/get-user-resource
CODEBUDDY_CN_CHECKIN_URL=http://127.0.0.1:<PORT>/v2/billing/meter/daily-checkin
```

Leave empty for production. Overrides can redirect credential-bearing requests and must not be copied into a production `.env`.
