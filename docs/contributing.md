# Contributing

## Principles

- Keep the runtime dependency-free unless a requirement cannot be met with Node/platform APIs.
- Prefer the smallest working diff.
- Preserve the local-only security posture.
- Do not add OAuth auto-login, MITM CA, subscription credential reuse, or raw-token output.
- Preserve the existing local API-key management boundary; do not expose it beyond the local admin surface without an explicit security review.

## Source of truth

- Runtime code defines behavior.
- Smoke tests define executable expectations.
- README is quickstart, not the full contract.
- `/docs` must be updated when routes, config, persistence, security, or UI workflows change.
- Mark uncertain upstream behavior as upstream-dependent.

## Change workflow

1. Read relevant route/provider/lib code.
2. Update or add one focused smoke assertion for non-trivial logic.
3. Keep raw credentials out of tests and examples.
4. Run `npm test`.
5. Search docs for stale claims.
6. Review `git diff` for secrets and accidental data files.

## Style

Use existing ESM/vanilla patterns. Match surrounding naming and comment density. Avoid introducing abstraction for one implementation. Validate trust-boundary input and redact error/output paths.

## Provider changes

Document endpoint, auth, refresh, quota, model catalog, test overrides, and uncertainty. Add a local stub case where practical. Never use a real provider token in tests.

## Dashboard changes

Keep server pagination for large pools, escape rendered text, preserve reduced-motion behavior, and avoid exposing credential values through DOM, API, logs, or screenshots. Use custom accessible confirmation modals for destructive actions; do not use browser `confirm`, `alert`, or `prompt`. Native file picker remains allowed for account `.json`/text import; keep semantic controls, native date/time inputs, and OS scrollbars unless a concrete UI requirement calls for replacement.
