# @app-builder/llm-client

Configurable LLM client used by the Intake and Codegen agents. Talks to any
GLM-API-compatible endpoint (OpenAI-style `POST {base_url}/chat/completions`
with `messages`/`tools`) — Zhipu's hosted GLM API, a self-hosted GLM
deployment, or another compatible endpoint — chosen entirely at runtime via
environment variables, never hardcoded.

## Configuration

Copy `.env.example` to `.env` and fill in:

| Variable          | Required | Default | Notes                                             |
|-------------------|----------|---------|----------------------------------------------------|
| `GLM_BASE_URL`    | yes      | —       | No trailing slash needed; one is stripped if present. |
| `GLM_API_KEY`     | yes      | —       | Sent as `Authorization: Bearer <key>`.             |
| `GLM_MODEL`       | yes      | —       | Model name as expected by that endpoint.           |
| `GLM_TIMEOUT_MS`  | no       | `60000` | Per-request timeout before aborting.               |
| `GLM_MAX_RETRIES` | no       | `2`     | Retries on timeout/network error/429/5xx only.     |

`loadGlmConfig()` throws `GlmConfigError` immediately if a required
variable is missing or a numeric one is invalid — config problems surface
at startup, not on the first agent call.

## Usage

```ts
import { GlmClient, loadGlmConfig } from "@app-builder/llm-client";

const client = new GlmClient(loadGlmConfig());

const result = await client.chat({
  messages: [{ role: "user", content: "Hello" }],
});

console.log(result.message.content);
```

## Design

- `LLMClient` (in `src/types.ts`) is the interface agent code depends on.
  `GlmClient` is the only implementation today; a different provider or a
  second GLM-compatible endpoint is a new implementation of the same
  interface, not a change to the agents that use it.
- Retries apply only to transient failures (timeout, network error, `429`,
  `5xx`) with exponential backoff — a `4xx` other than `429` fails
  immediately since retrying won't help.
- Tool-calling support is required for the Codegen Agent's bash/file-write
  loop — confirm the configured `GLM_MODEL` supports OpenAI-style
  `tools`/`tool_calls` before using it there.

## Commands

```bash
npm run build --workspace @app-builder/llm-client   # compile to dist/
npm run test --workspace @app-builder/llm-client    # unit tests (mocked fetch, no network)
npm run smoke --workspace @app-builder/llm-client   # manual real-network check, needs .env
```
