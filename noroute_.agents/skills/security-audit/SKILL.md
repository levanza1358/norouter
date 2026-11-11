# Security audit

Use this skill for credentials, provider URLs, authentication, exposure, logging, error output, or untrusted input.

## Checklist

- Keep the default bind on loopback. Treat `HOST`, CORS, and `REQUIRE_API_KEY` as exposure controls, not complete authentication.
- Never return or log raw access tokens, refresh tokens, API keys, cookies, authorization headers, or fingerprints.
- Check every new response, error, dashboard render, and test fixture for secret leakage.
- Treat custom provider `baseUrl` as untrusted input. Preserve validation and avoid turning it into an unintended internal-network fetch surface.
- Keep `/v1` API-key comparison behavior exact. Do not imply that the key protects dashboard or `/api` routes.
- Keep request size, timeout, redirect, and upstream error handling bounded.
- Use local stubs and synthetic credentials only. Never add real secrets to fixtures, screenshots, logs, or documentation.
- Document active exposure and limitations when a security-sensitive behavior changes.

## Verify

Run `npm test`, inspect affected response paths, and review the final diff for secrets and unsafe new network surfaces.
