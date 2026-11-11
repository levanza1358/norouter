# ADR 0001: Dependency-free runtime and SQLite

- Status: accepted
- Date: 2026-10-27

## Context

Norouter is a local gateway with a small dashboard and an account pool that may hold hundreds or thousands of accounts. A build chain or third-party ORM would add setup cost. Account writes need durable uniqueness, transactions, and pagination.

## Decision

Use Node ESM built-ins and vanilla browser assets. Use Node's built-in `node:sqlite` / `DatabaseSync` for accounts, custom providers, custom models, and account usage. Enable WAL, NORMAL sync, and busy timeout.

## Consequences

Positive:

- No `node_modules` or build step.
- One local file is easy to back up.
- SQL uniqueness/transactions handle duplicate and bulk import safely.
- Server-side pagination scales the dashboard DOM.

Trade-offs:

- Requires a Node runtime with `node:sqlite`.
- Credential columns are plaintext in the local DB and need filesystem protection.
- Global request stats remain in memory for now.
- SQLite is local single-process storage, not a distributed database.

## Revisit when

Move to a different store only for multi-process deployment, centralized auth/audit, retention/reporting requirements, or a runtime that no longer provides suitable SQLite support.
