# Release checklist

## Scope and code

- [ ] README links to current docs.
- [ ] `/docs/status.md` matches implemented routes.
- [ ] Managed API-key behavior is documented, approved, and remains local-admin-only.
- [ ] CodeBuddy production endpoint and test overrides are distinguished.

## Secrets

- [ ] No raw access/refresh/API keys in source, fixtures, docs, screenshots, logs, or git diff.
- [ ] `.env`, SQLite DB, WAL/SHM, migrated JSON are ignored.
- [ ] Test DB is separate from operator DB.
- [ ] Any previously exposed credential is revoked/rotated.

## Runtime

- [ ] If using default `HOST=0.0.0.0`, firewall and external auth/TLS protect dashboard/admin routes; otherwise set `HOST=127.0.0.1`.
- [ ] Autostart registration is verified on the target OS; uninstall confirmation is tested without deleting unrelated paths.
- [ ] Test-only URL overrides are empty.
- [ ] `REQUIRE_API_KEY` behavior is understood; `/api` is not gated.
- [ ] SQLite backup exists and includes WAL state where relevant.

## Behavior

- [ ] `/health` works.
- [ ] `/v1/models` works.
- [ ] Controlled stream and non-stream chat work.
- [ ] Account preview/import/masking work.
- [ ] Active-only model test and answer toast work.
- [ ] Quota displays upstream/local distinction.
- [ ] Custom provider/model validation works.

## Verification

- [ ] `npm test` passes.
- [ ] Documentation stale-claim search passes.
- [ ] Internal links resolve.
- [ ] Error paths reviewed for raw credential leakage.
