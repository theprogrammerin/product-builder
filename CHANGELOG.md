# Changelog

Notable changes to this project, newest first. Add an entry here whenever
a feature lands. [`docs/blueprints/features.md`](docs/blueprints/features.md)
is the current-state summary these entries roll up into — update both
together.

## Unreleased

### Phase 0.5 — Basic chat vertical slice

- Add project tracking: create/select a project, track its stage through
  `ideation → product_requirements → ux → design → development → production`.
  (`packages/orchestrator/src/projectStore.ts`, `packages/web/src/App.tsx`)
- Scope chat history per project instead of an anonymous session id; the
  orchestrator now 404s on an unknown `projectId`.
  (`packages/orchestrator/src/app.ts`)
- Add the orchestrator service: Express API with `/api/chat` and
  `/api/health`, backed by `@app-builder/llm-client`.
  (`packages/orchestrator`)
- Add the web chat UI: Vite + React single-page app, dev-proxied to the
  orchestrator. (`packages/web`)

### Phase 0 — Stack spec & LLM client

- Add the Stack & Guidelines Spec: locked versions and 7 codegen guideline
  docs for future generated apps. (`stack-spec/`)
- Add `@app-builder/llm-client`: a provider-agnostic `LLMClient` interface
  with a `GlmClient` implementation for any GLM-API-compatible endpoint,
  configurable via `GLM_BASE_URL`/`GLM_API_KEY`/`GLM_MODEL`, with
  retry/backoff and fail-fast config validation. (`packages/llm-client`)
