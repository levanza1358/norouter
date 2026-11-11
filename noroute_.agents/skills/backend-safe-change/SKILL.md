# Backend safe change

Use this skill for routes, providers, model resolution, database, HTTP, SSE, and account behavior.

## Rules

- Follow existing module boundaries instead of creating a new abstraction layer.
- Keep HTTP parsing, validation, status codes, JSON shapes, and SSE framing consistent with neighboring routes.
- Keep provider registration in `src/providers/index.js`; keep persistence in `src/lib/db.js` and its existing callers.
- Mask credentials at every output boundary. Never log or return raw tokens, API keys, cookies, or authorization headers.
- Use the local upstream stub for provider and streaming tests. Never require real credentials for a test.
- Preserve retry, timeout, account-disable, and error semantics unless the request explicitly changes them.
- Treat schema changes as compatibility work: migrate existing data or reject the change until a migration path exists.
- Keep in-memory statistics separate from persisted state.

## Verify

- Run syntax checks for every touched JavaScript file.
- Run `npm test`.
- Exercise affected HTTP routes and SSE behavior with the existing smoke suite or a focused test.
- Report real output, including failures.
