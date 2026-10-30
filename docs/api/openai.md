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

The router resolves `cbcn`, `codebuddy-cn`, or a bare unambiguous model. The request body is otherwise forwarded with the resolved model.

### Streaming

With `stream: true`, response is SSE from the upstream path:

```http
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
```

CodeBuddy is always called as a stream. The router relays bytes and records usage when available.

Some OpenAI-compatible upstreams include `"tool_calls": []` in ordinary reasoning and content deltas. An empty array is still non-null, so OpenAI-compatible SDKs interpret it as a tool-call frame and close the current reasoning block on every delta. The relay removes empty `tool_calls` arrays for every provider (shipped or custom) before forwarding; non-empty tool-call frames are unchanged.

### Non-stream

Without `stream: true`, the router buffers SSE and returns one OpenAI-shaped completion. It requests usage with `stream_options.include_usage=true`; if the upstream rejects `stream_options`, it retries once without that property. Plain JSON upstream responses are passed through.

The accumulator preserves content, reasoning content, tool calls, finish reason, and usage when present.

### Reasoning compatibility

The router accepts `reasoning_effort` directly, plus harness-style `reasoning_level`, `thinking.level`, and `reasoning.level`. For providers that declare a reasoning mapping, explicit levels are translated to the provider parameters. CodeBuddy CN supports `low`, `medium`, `high`, and `xhigh`; it adds `reasoning_summary: "auto"` when a level is requested. `none`/`off` removes mapped reasoning parameters. Ordinary requests are not forced into a reasoning mode.

The router transports reasoning; it does not invent hidden chain-of-thought, execute tools, or run an autonomous agent loop. Tools remain in the Agent Harness boundary.

## Request limits and timeout

- Chat JSON body limit: 10 MiB.
- Default upstream timeout: `UPSTREAM_TIMEOUT_MS=300000`.
- Malformed JSON/model errors return 400.
- Client disconnect or timeout may return 499 if headers were not sent.
- Network/upstream failures return 502 unless an upstream status is relayed.

## Credential failover

- Pool account selected round-robin.
- 401/403: refresh/retry once where refresh token exists.
- 429: cooldown account and retry another account up to four attempts.
- 400/404/500: relay rather than rotating needlessly.
- No available pooled account: 429 with `retry_at` when known.
- No pool and no fallback credential: 401.

## Error caveat

Upstream errors are not normalized into one universal schema. Non-stream in-stream SSE errors become a 502; streamed upstream bytes are relayed. Do not build clients that depend on one exact error shape beyond HTTP status and useful message fields.
