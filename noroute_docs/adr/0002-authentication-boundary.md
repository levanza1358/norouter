# ADR 0002: Authentication boundary and manual credentials

- Status: accepted
- Date: 2026-10-27

## Context

The gateway needs provider credentials and a client-facing OpenAI-compatible endpoint. Automated OAuth/device-code login, credential interception, and subscription-session reuse are unsafe and out of scope. The dashboard/admin API is currently designed for one local operator.

## Decision

Accept provider credentials only as manually pasted SQLite account-pool values. Reserve root `.env` for proxy configuration and controlled upstream endpoint overrides. Support explicit CodeBuddy refresh-token exchange. Do not implement OAuth login/polling/browser automation or MITM root CA. Keep router API-key gate env-only and limited to `/v1` until a separate authentication design is approved.

## Consequences

Positive:

- Clear operator consent and credential provenance.
- No hidden login/session capture flow.
- Account rotation is explicit and observable.
- Simple local setup.

Trade-offs:

- Dashboard HTML may use an optional page password; `/api` remains unauthenticated today.
- One static router API key has no expiry/roles/limits.
- With the default all-interface bind, operator must protect firewall, filesystem, and reverse-proxy boundaries; `HOST=127.0.0.1` remains the local-only option.
- Refresh tokens are sensitive plaintext DB values.

## Revisit when

Add admin authentication/RBAC/audit only through a separate threat-model and product decision. Do not infer approval from the existence of `ROUTER_API_KEY`.
