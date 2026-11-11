# Custom providers

Custom providers are created from **Providers → Add a provider** or `POST /api/providers` and persisted in SQLite.

## Supported shape

- OpenAI-compatible chat endpoint.
- Base URL must begin with `http://` or `https://`.
- Chat path defaults to `/chat/completions`.
- At least one model is required.
- Provider credentials, when needed, are added through the SQLite account pool.
- Provider ID is slugified to lowercase letters, digits, and dashes, max 40 characters.
- Model IDs accept letters, digits, `.`, `_`, `:`, `/`, `+`, `-`, max 120 characters.

## Open versus credentialed

Custom providers created by the dashboard are open endpoints by default; Norouter sends no Authorization header. Add account-pool support only when the provider adapter explicitly defines it. Generic custom providers do not have provider-specific refresh support.

## Model discovery

`POST /api/providers/:id/models/fetch` requests `<base-url>/models`. This is a convention, not a universal OpenAI guarantee. Returned IDs are added to the custom model table when valid and new.

## No translation

Custom providers are forwarded as OpenAI-shaped JSON. Anthropic, Gemini, vendor-specific auth, vendor-specific headers, and response translation are not implemented by this adapter.

## Network warning

Custom provider URLs can target localhost, private networks, arbitrary hosts, and plaintext HTTP. This is useful for local Ollama-like servers but creates SSRF and credential-routing risk when admin surfaces are exposed. Keep the dashboard/admin API local and validate every URL before saving.
