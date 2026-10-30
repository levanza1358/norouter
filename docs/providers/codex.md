# OpenAI Codex

Codex is registered as provider `codex` with alias `cx`.

- Transport: OpenAI Responses API at `https://chatgpt.com/backend-api/codex/responses`.
- OAuth: PKCE login through ChatGPT, local callback `127.0.0.1:1455`.
- API key: separate OpenAI API route at `https://api.openai.com/v1/chat/completions`; this is not Codex OAuth.
- OAuth access tokens are refreshed proactively and refresh-token rotation is treated as one-time use.
- The provider requires an account and is not used until an operator adds one.

Codex OAuth state and PKCE verifier live only in process memory for ten minutes and are single-use. Tokens are stored in the local account pool; they are never returned or logged. The local callback rejects non-local Host headers.

Responses support is intentionally limited to the translator's documented chat subset. Unsupported request fields return a clear 400 rather than being silently discarded.

The model catalog is conservative and may change as OpenAI's backend changes. Norouter does not provide shell, filesystem, command execution, or agent tools through Codex.
