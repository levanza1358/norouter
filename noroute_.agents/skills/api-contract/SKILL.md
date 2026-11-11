# API contract

Use this skill for `/v1`, `/api`, HTTP status, JSON response, request validation, or SSE changes.

## Rules

- Treat `docs/api/openai.md` and `docs/api/admin.md` as promises only when code and smoke tests support them.
- Preserve OpenAI-compatible model IDs, chat request behavior, streaming headers, SSE framing, and non-stream accumulator behavior unless explicitly changed.
- Preserve existing status-code meaning and safe error fields. Do not normalize upstream errors silently.
- Keep account failover, refresh, cooldown, retry, and no-credential behavior stable.
- Update the relevant API documentation and focused smoke coverage when a public contract changes.
- Never document raw credentials or internal request headers.

## Verify

Run `npm test`. Exercise the affected route with the existing smoke/stub path. Confirm docs, handler, and test agree on method, path, status, and response shape.
