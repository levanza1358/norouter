# OpenAI-compatible API

Base URL default: `http://<server-ip>:5555/v1` (bind `0.0.0.0`).

## Authentication

Disabled by default for localhost. When `REQUIRE_API_KEY=true`:

```http
Authorization: Bearer <ROUTER_API_KEY>
```

Only `/v1` routes are gated. Admin/dashboard routes are not protected by this setting.

## `GET /v1/models`

Response shape:

```json
{
  "object": "list",
  "data": [
    {
      "id": "cbcn/glm-5.3",
      "object": "model",
      "created": 0,
      "owned_by": "codebuddy-cn"
    }
  ]
}
```

`created` is generated at request time. Only provider-prefixed IDs are emitted so clients do not show duplicate model entries. Catalog and custom models are included. Chat resolution may still accept a bare unambiguous ID.

Combos are appended to the same list with `owned_by: "norouter"` and the combo name as `id`. They never replace or hide provider models.

### Combos

A combo is a named virtual model whose value is an ordered list of real models:

```json
{ "model": "premium-coding" }
```

Resolution checks the combo name **before** normal model resolution. A name containing `/` is always treated as `provider/model` and never as a combo. Models are tried in array order; the first one that answers serves the request.

Fallback only moves to the next model for statuses that describe the target: `401`, `402`, `403`, `404`, `429`, and `5xx`. A `400` caused by the request itself (malformed body, context overflow, unsupported parameter) is returned immediately — retrying it on another model would bill another quota for the same client bug.

Streaming is safe: no SSE headers or bytes reach the client until one model returns a successful response, so a stream never mixes two models. Once bytes start flowing the model is locked.

If every model fails, the response status comes from the first fallback-triggering failure, and the message names the combo and the models attempted:

```json
{
  "error": {
    "message": "Combo \"premium-coding\" failed. Tried: cbcn/glm-5.3 → cbcn/minimax-m3. <upstream message>",
    "type": "invalid_request_error",
    "combo": "premium-coding",
    "attempted": ["cbcn/glm-5.3", "cbcn/minimax-m3"]
  }
}
```

Usage and statistics always attribute the request to the model that actually served it, never to the combo name.

## `POST /v1/chat/completions`

Example:

```json
{
  "model": "cbcn/glm-5.3",
  "messages": [
    { "role": "user", "content": "Hello" }
  ],
  "stream": false
}
```

The router resolves `cbcn`, `codebuddy-cn`, or a bare unambiguous model. The request body is otherwise forwarded with the resolved model. For account-backed providers, a rate-limited, rejected, or failed account is parked temporarily and the same request is retried with each remaining healthy account. A request-shaped `400` is not retried across accounts.

Antigravity model IDs are the gateway's own ids (`ag/gemini-3.8-flash-high`), and the catalog mirrors what `v1internal:fetchAvailableModels` reports. The bare `ag/gemini-3.8-flash` alias routes to `gemini-3.8-flash-medium`. A model the account's plan does not expose answers the gateway's `404`; an exhausted shared pool answers `429` with the reset delay. Both are relayed unchanged.

### Streaming

With `stream: true`, response is SSE from the upstream path:

```http
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
```

CodeBuddy is always called as a stream. The router relays bytes and records usage when available.

A stream counts as success only when the upstream proves the turn ended: a `finish_reason`, a `[DONE]` sentinel, or the wire's own terminal event (`response.completed` for Responses, `message_delta`/`message_stop` for Anthropic, `finishReason` for Antigravity). If the connection closes before that, or the upstream sends an error frame, the relay stops and writes one final error frame instead of a synthetic `[DONE]`:

```json
{"error":{"message":"Upstream stream ended before completion (provider/model).","type":"upstream_error","code":"stream_truncated"}}
```

`code` is `stream_truncated` for a cut stream and `stream_error` when the upstream reported the failure itself. Bytes already relayed stay on the wire; the error frame is the terminal event. A failed turn is recorded as an error, not as a served request, and it does not park the account, because a gateway closing a connection says nothing about the credential.

Antigravity streams from `v1internal:streamGenerateContent?alt=sse`; each Gemini frame is translated into an OpenAI `chat.completion.chunk` before it reaches the client, and the final frame carries usage. A non-stream Antigravity request calls `v1internal:generateContent` instead and returns a plain completion. The Cloud Code envelope, Gemini `contents`, and tool/schema conversion are internal: clients always see the OpenAI shape.

Some OpenAI-compatible upstreams include `"tool_calls": []` in ordinary reasoning and content deltas. An empty array is still non-null, so OpenAI-compatible SDKs interpret it as a tool-call frame and close the current reasoning block on every delta. The relay removes empty `tool_calls` arrays for every provider (shipped or custom) before forwarding; non-empty tool-call frames are unchanged.

Upstage and some other OpenAI-compatible upstreams name the reasoning field `reasoning` instead of `reasoning_content`, in stream deltas and plain JSON messages alike. The relay mirrors that value onto `reasoning_content` when the canonical field is absent and keeps the original, so clients that read only `reasoning_content` still show the chain of thought. This applies to every provider on the OpenAI wire (shipped or custom); the Responses, Anthropic, and Antigravity translations are unaffected.

### Non-stream

Without `stream: true`, the router buffers SSE and returns one OpenAI-shaped completion. For upstreams that are always streamed (`forceStream`, shipped or custom), it requests usage with `stream_options.include_usage=true`; if the upstream rejects `stream_options`, it retries once without that property. A buffered stream that ends before any terminal frame, a plain JSON body carrying `error`, or an in-stream error frame becomes a 502 with an `error` object instead of a 200 with a partial completion. Plain JSON upstream responses are passed through after the same reasoning-alias normalization.

The accumulator preserves content, reasoning content, tool calls, finish reason, and usage when present.

### Reasoning compatibility

The router accepts `reasoning_effort` directly, plus harness-style `reasoning_level`, `thinking.level`, and `reasoning.level`. For providers that declare a reasoning mapping, explicit levels are translated to the provider parameters. CodeBuddy CN supports `low`, `medium`, `high`, and `xhigh`; it adds `reasoning_summary: "auto"` when a level is requested. `none`/`off` removes mapped reasoning parameters. Ordinary requests are not forced into a reasoning mode.

The router transports reasoning; it does not invent hidden chain-of-thought, execute tools, or run an autonomous agent loop. Tools remain in the Agent Harness boundary.

### Vision routing

One global rule on the Combos page can force image requests onto a fixed model chain. When enabled, a chat request is routed there if its newest message carries an `image_url`, `input_image`, or `image` part — a fresh user turn or a tool result that just returned a screenshot — regardless of the `model` it named: prefixed model, bare model, or combo. Clients resend the whole conversation, so images that are merely replayed do not reroute anything: an image from an earlier turn, or the same image carried through the next calls of a tool loop, keeps the requested or default model. When disabled, behavior is unchanged and the requested or default model serves the request.

On a request that brings no new image — a later text-only turn or a tool-loop continuation — replayed image parts are replaced with a short text placeholder before the request goes to its own model. Some upstreams refuse image input outright (Upstaged answers `400 Image input is not allowed for this model`); the vision chain already answered the image, so the placeholder keeps the conversation usable without pretending the original model saw the pixels.

The forced chain runs with combo semantics: one credential attempt per target, fallback only for target-shaped failures, streaming-safe, and usage attributed to the model that actually served. If no configured target resolves, the request keeps its original model. A total failure returns the attempted list:

```json
{
  "error": {
    "message": "Vision routing failed. Tried: cbcn/glm-5.3 → cbcn/minimax-m3. <upstream message>",
    "type": "invalid_request_error",
    "vision": true,
    "attempted": ["cbcn/glm-5.3", "cbcn/minimax-m3"]
  }
}
```

### Aliases, routing rules, and per-key defaults

Three operator settings on the Routing page decide which model actually serves a request. They apply to every inbound wire (`/v1/chat/completions`, `/v1/responses`, `/v1/messages`). Precedence, highest first: vision routing → per-key default → alias → routing rule → combo → plain model.

**Aliases** give a client-facing name to a model or combo:

```json
{ "aliases": { "chat-alias": "cbcn/glm-5.3", "fast": "premium-coding" } }
```

A request for `chat-alias` is resolved as `cbcn/glm-5.3`, and an alias may point at a combo so the combo's fallback chain runs. Aliases are resolution names, not catalog entries: `/v1/models` does not list them. They cannot chain (a target must be a real model or an existing combo) and cannot shadow a real model or combo name; both are rejected when saving.

**Routing rules** replace the requested model with a fallback chain when every condition matches:

```json
{
  "name": "Premium tier",
  "match": { "header": { "name": "x-route-tier", "value": "premium" }, "hasTools": true },
  "models": ["cbcn/glm-5.3", "cbcn/minimax-m3"]
}
```

Conditions are ANDed and at least one is required: `header` (case-insensitive substring of the named request header), `apiKeyId` (the managed key that authenticated the call; only meaningful while `REQUIRE_API_KEY` is on), `minContextTokens` (rough `characters/4` plus 1,000 tokens per image), and `hasTools`. Rules run in order; the first enabled match wins, and a rule whose targets all fail to resolve is skipped so a later rule can answer. The chain uses combo semantics — same fallback statuses, streaming safety, and serving-model attribution — and a total failure names the rule:

```json
{
  "error": {
    "message": "Routing rule \"Premium tier\" failed. Tried: cbcn/glm-5.3 → cbcn/minimax-m3. <upstream message>",
    "type": "invalid_request_error",
    "rule": "Premium tier",
    "attempted": ["cbcn/glm-5.3", "cbcn/minimax-m3"]
  }
}
```

**Per-key default model** fills a missing `model` for requests authenticated by that managed key. It applies only while `REQUIRE_API_KEY` is on, an explicit `model` always wins, and the value may be a model or a combo. A client that sends no model and no key still gets the usual 400.

The request log records the model the client asked for, the reason (`direct`, `combo`, `vision`, `alias`, `rule`), and the attempted chain, so a rewritten request stays auditable. The reason is the last step that changed the route: an alias rewritten into a rule chain is reported as `rule`.

## `POST /v1/responses`

The Responses API shape is accepted for clients that speak it directly (Codex CLI and similar). The request is translated to the chat pipeline, so model prefixes, combos, vision routing, credential failover, and usage accounting behave exactly as they do for `/v1/chat/completions`.

```json
{
  "model": "cbcn/glm-5.3",
  "input": "halo",
  "stream": true
}
```

`input` may be a string or a list of items. `function_call` and `function_call_output` items are forwarded as assistant tool calls and tool results, so a full tool loop survives the translation. `input_image` parts are converted to image parts and therefore still trigger vision routing. Fields the chat pipeline cannot honor are rejected with 400 instead of being silently dropped: `previous_response_id` (send the full conversation each turn), non-function tools, and unknown item types. Conversations are stateless; nothing is stored.

With `stream: true` the reply is rebuilt as Responses events — `response.created`, `response.output_item.added`, `response.output_text.delta`, `response.output_item.done`, `response.completed` — and streamed tool calls become `function_call` items with `response.function_call_arguments.delta` events. Argument fragments that arrive before the function name are buffered and replayed once the name is known. An upstream failure becomes one terminal `response.failed` event after `response.created`; a truncated relay closes with `response.failed` too. There is no chat `[DONE]` sentinel and no synthetic `response.completed` after a failure. A stream that fails before its first event is reported with a real HTTP error status instead of a 200.

Without streaming the reply is a single `response` object with `output` items and mapped `usage`. `response.completed` is the terminal stream event even when the status is `incomplete`, so clients that wait for it always finish.

## `POST /v1/messages`

The Anthropic Messages shape is accepted for clients that speak it directly (Claude Code and similar). The request is translated to the chat pipeline, so model prefixes, combos, vision routing, credential failover, and usage accounting behave exactly as they do for `/v1/chat/completions`. Only the inbound shape is translated; outbound provider wires are untouched.

```json
{
  "model": "cbcn/glm-5.3",
  "max_tokens": 1024,
  "system": "Be brief.",
  "messages": [{ "role": "user", "content": "halo" }],
  "stream": true
}
```

`system` becomes a leading system message. `max_tokens` is required in spirit and defaults to 4096 when omitted; non-positive values are rejected. `stop_sequences`, `temperature`, and `top_p` are forwarded. `tools` are converted to function tools and `tool_choice` values map as `auto` → `auto`, `any` → `required`, `none` → `none`, and `{type: "tool", name}` → a named function. Assistant `tool_use` blocks become chat tool calls and user `tool_result` blocks become `role: "tool"` messages, so a full tool loop survives the translation. `image` blocks (base64 or URL) become image parts and therefore still trigger vision routing. History `thinking` and `redacted_thinking` blocks are dropped, as are `top_k`, `thinking`, `metadata`, and `service_tier`. Requests with no messages, unknown content blocks, non-function (server) tools, or an unsupported `tool_choice` are rejected with 400 in Anthropic error shape (`{"type": "error", "error": {"type", "message"}}`) instead of being silently dropped.

With `stream: true` the reply is rebuilt as Messages events — `message_start`, `content_block_start`/`content_block_delta`/`content_block_stop`, `message_delta`, `message_stop`. Reasoning streams as a `thinking` block with `thinking_delta` events and visible text as a `text` block with `text_delta` events. Tool calls are buffered while the chat stream runs and emitted as complete `tool_use` blocks with one `input_json_delta` before `message_stop`, because chat tool calls can interleave while Anthropic content blocks are sequential. Arguments that arrive before the function name are kept. An upstream failure becomes one terminal `event: error` (`rate_limit_error` or `api_error`) with no `message_delta` or `message_stop`; a stream that fails before its first event returns a real HTTP error with the Anthropic error body.

Without streaming the reply is a single `message` object with a `content` array (text and `tool_use` blocks), a mapped `stop_reason` (`end_turn`, `tool_use`, `max_tokens`, `refusal`), and `usage.input_tokens`/`usage.output_tokens`.

## Request limits and timeout

- Chat JSON body limit: 10 MiB.
- Default upstream timeout: `UPSTREAM_TIMEOUT_MS=300000`.
- Malformed JSON/model errors return 400.
- Client disconnect or timeout may return 499 if headers were not sent.
- Network/upstream failures return 502 unless an upstream status is relayed.

### Daily budget

A managed API key with a daily token or cost cap configured in Settings is refused with 429 once the cap is reached, before any upstream call:

```json
{"error":{"message":"Daily budget reached for key … (cost $5.00/$5.00). It resets at local midnight.","type":"budget_error","code":"budget_exhausted","scope":"key:…","day":"2026-11-13","reasons":["cost"],"limit":{"cost":5},"used":{"requests":12,"tokens":90000,"tokensIn":70000,"tokensOut":20000,"cost":5}}}
```

Unmanaged auth (env credential or no auth) has no per-key budget. A capped provider never surfaces as an error from a failover chain: the chain skips it and continues, failing only when no other target can serve. Cost is an estimate from list prices, not billing. See [`admin.md`](admin.md#budgets).

## `POST /v1/images/generations`

OpenAI-compatible image generation. Example:

```json
{
  "model": "cbcn/hunyuan-image-alpha",
  "prompt": "a lighthouse at dusk",
  "n": 1,
  "size": "1024x1024"
}
```

Response is the OpenAI shape:

```json
{ "created": 1800000000, "data": [ { "url": "https://..." } ] }
```

- `prompt` is required; `n` and `size` are forwarded only when the client sends them.
- `model` may be prefixed (`cbcn/hunyuan-image-alpha`) or bare when unambiguous. Image models are resolved separately from chat models; the CodeBuddy image models are `hunyuan-image-alpha` and `hunyuan-image-alpha-edit`.
- The account pool is shared with chat: a rejected account is parked and the request retries each remaining healthy account, mirroring chat failover.
- The CodeBuddy gateway answers on an undocumented `/v2/images/generations` route whose payload is `{ data: { data: [{ url }] } }`; the router unwraps it into the OpenAI shape above.

## `POST /v1/embeddings`

CodeBuddy CN supports OpenAI-compatible embeddings through its account pool:

```json
{
  "model": "cbcn/hunyuan-embedding",
  "input": "text to embed"
}
```

`input` accepts a non-empty string or an array of non-empty strings. Available models: `cbcn/hunyuan-embedding` and `cbcn/bge-m3`. The router forwards only `model` and `input`, normalizes the response to `{ object: "list", data: [{ object: "embedding", index, embedding }], model, usage? }`, and retries every remaining healthy account after upstream account failures. Input text, vectors, tokens, and authorization headers are never written to logs.

## Audio, video, and other media

Norouter currently exposes image generation and embeddings for CodeBuddy CN. It does **not** expose `/v1/audio/*` or `/v1/videos/*` yet: Mirai's CodeBuddy inspection shows TTS requires a separate `X-Api-Key`, while CodeBuddy has no verified STT/video route using the account OAuth credential. Adding placeholder routes would fail unpredictably and violate the provider boundary.

Audio speech/transcription and asynchronous video generation will be added only with a verified provider adapter, bounded multipart/body handling, polling semantics, and hermetic upstream stubs. No audio/video request is sent by norouter today.

## Credential failover and warmup

- Pool account selected round-robin.
- If every pooled account is parked but its cooldown has expired, norouter performs on-demand quota warmup for expired parked accounts, then retries normal selection.
- Warmup never runs while a healthy account is available, never sends a dummy chat prompt, and does not count as chat usage.
- 401/403: refresh/retry once where refresh token exists.
- 401/403: refresh/retry once where refresh token exists.
- 429: cooldown account and retry another account up to four attempts.
- 400/404/500: relay rather than rotating needlessly.
- No available pooled account: 429 with `retry_at` when known.
- No pool and no fallback credential: 401.

## Error caveat

Upstream errors are not normalized into one universal schema. A streamed turn that fails before a terminal frame ends with a single error frame carrying `code: "stream_truncated"` or `"stream_error"` and never with `[DONE]`; non-stream and buffered failures return HTTP 502 with `{ "error": { "message", "type": "upstream_error" } }`. Do not build clients that depend on one exact error shape beyond HTTP status, `code`, and useful message fields.
