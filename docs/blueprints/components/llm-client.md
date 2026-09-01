# Component Blueprint: `packages/llm-client`

## Purpose

Provider-agnostic LLM client. Every agent talks to a model through this
package, never to an HTTP endpoint directly — swapping the GLM deployment,
or adding a second provider later, means changing this package, not its
callers.

## Key files

- [`src/types.ts`](../../../packages/llm-client/src/types.ts) — the
  `LLMClient` interface plus wire-agnostic message/tool types
- [`src/config.ts`](../../../packages/llm-client/src/config.ts) —
  `loadGlmConfig()`, fail-fast env validation
- [`src/glmClient.ts`](../../../packages/llm-client/src/glmClient.ts) —
  `GlmClient`, the only `LLMClient` implementation today
- [`README.md`](../../../packages/llm-client/README.md) — usage and full
  configuration reference

## Configuration

Required: `GLM_BASE_URL`, `GLM_API_KEY`, `GLM_MODEL`. Optional:
`GLM_TIMEOUT_MS`, `GLM_MAX_RETRIES`. `loadGlmConfig()` throws
`GlmConfigError` immediately if a required var is missing — see the
package README for the full table.

## Behavior

- Retries only on timeout, network error, `429`, or `5xx`, with
  exponential backoff; any other non-2xx fails immediately.
- Maps camelCase `ChatMessage`/`ToolCall` types to and from the
  OpenAI-style wire format GLM speaks (`POST {baseUrl}/chat/completions`).

## Tests

[`test/`](../../../packages/llm-client/test) — 15 tests, mocked `fetch`,
no network hit. `npm run smoke --workspace @app-builder/llm-client` sends
one real request to whatever endpoint is in `.env` — use it to verify
connectivity/credentials, not in CI.

## Known limitations

- No streaming support yet.
- Single provider implementation (GLM). The `LLMClient` interface is
  ready for a second implementation; nothing currently needs one.
