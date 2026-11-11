# Troubleshooting

## `401 Invalid or missing router API key`

Cause: `REQUIRE_API_KEY=true` and `/v1` request lacks exact `Authorization: Bearer <ROUTER_API_KEY>`.

Fix: send the header or disable the gate for loopback testing. This setting does not protect `/api`.

## `401 No credential for codebuddy-cn`

No usable account exists in the SQLite pool. Add or re-enable an account on the provider page; `.env` is not used for upstream credentials.

## `429 Every account is cooling down`

All pooled accounts are cooling, errored, paused, or unusable. Inspect account status and `retry_at`; wait, resume, replace token, or add an account.

## `401/403` from upstream

Credential rejected or risk-controlled. For pooled CodeBuddy accounts, refresh-token retry may happen once. Check account error state and rotate credential if rejected.

## `409` during account/model/provider operation

Duplicate account fingerprint, custom model, or custom provider ID. Use preview/list first; duplicates are intentionally not silently overwritten.

## `404 Unknown model`

Use `/v1/models`. Prefix with `cbcn/` or `codebuddy-cn/`, or use bare ID only when one provider owns it.

## `502` upstream error

Check endpoint, credential, network, upstream response, and timeout. For CodeBuddy, verify production endpoint and clear test-only URL overrides. Non-stream in-stream error frames become 502.

## Model fetch fails

Custom discovery assumes `<base-url>/models`. CodeBuddy may not expose a conventional models route. Use bundled catalog or add a custom model manually.

## Model test has no toast/answer

Confirm account is `Active`, request reached `/api/providers/:id/models/test`, and response result contains `ok`/`answer`. Test failure shows error toast. Browser reduced-motion only changes animation, not content.

## Quota says no package

Upstream quota payload may be empty, changed, rejected, or account lacks a visible package. Local relayed-traffic quota is separate. Inspect safe server error and upstream availability; do not infer token validity from an empty package alone.

## Dashboard says degraded while account pool exists

Provider readiness in status snapshots and detail views can differ by source. Inspect provider detail pool count and account state; `.env` fallback readiness is not identical to pool readiness.

## Stats reset after restart

Expected for the live dashboard cards and `/api/status`: those counters and the uptime are in-memory. The `/usage` page reads `usage_hourly` from SQLite and keeps its history across restarts. `account_usage` day keys are UTC; `usage_hourly` buckets follow the server machine's local timezone.

## Database/WAL issue

Stop process before copying/restoring. Keep `.db`, `-wal`, and `-shm` together. Use a separate `NOROUTER_DB` for tests. Never delete the operator database without a verified backup.
