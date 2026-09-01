# Feature Blueprint

Snapshot of what this project can actually do today. For where it's
headed, see [`docs/backlog.md`](../backlog.md); for how each
piece works, see the per-component docs under
[`components/`](./components/).

## Opinionated stack for generated apps

A locked set of libraries/versions and codegen guidelines that future
agents must follow. Not yet consumed by any running code — this is the
spec Phase 1's Codegen Agent will build against.

- Locked versions: [`stack-spec/versions.yaml`](../../stack-spec/versions.yaml)
- Decision guidelines (one file per topic): [`stack-spec/guidelines/`](../../stack-spec/guidelines/)
- Details: [component blueprint](./components/stack-spec.md)

## Configurable LLM connectivity

Chat (with tool-calling support) against any GLM-API-compatible endpoint,
driven entirely by runtime config — no hardcoded provider.

- `GLM_BASE_URL` / `GLM_API_KEY` / `GLM_MODEL` (+ optional timeout/retries)
- Retries on timeout/429/5xx with backoff; fails fast on missing config
- Package: [`packages/llm-client`](../../packages/llm-client) — [component blueprint](./components/llm-client.md)

## Project tracking

Create or select a project and track its stage through a fixed pipeline:
`ideation → product_requirements → ux → design → development → production`.

- API: `GET/POST /api/projects`, `PATCH /api/projects/:id/stage` — [`projectStore.ts`](../../packages/orchestrator/src/projectStore.ts), [`app.ts`](../../packages/orchestrator/src/app.ts)
- UI: project dropdown, "+ New project" inline form, stage selector — [`App.tsx`](../../packages/web/src/App.tsx)
- Stage changes are manual today — nothing yet infers or advances a stage automatically.

## Chat, scoped per project

Send a message to a selected project; the orchestrator keeps that
project's conversation history and replays it as context on every turn.

- API: `POST /api/chat` (`{ projectId, message }` → `{ reply, finishReason }`, 404 on an unknown project) — [`app.ts`](../../packages/orchestrator/src/app.ts)
- UI: single-page chat log + input — [`App.tsx`](../../packages/web/src/App.tsx)
- History is in-memory only (per orchestrator process) — lost on restart.
- No app-generation logic behind it yet — messages go straight to the
  configured GLM model with a static system prompt.

## Health check

- `GET /api/health` reports the configured GLM `baseUrl`/`model` without
  leaking the API key — [`app.ts`](../../packages/orchestrator/src/app.ts)

## Not yet built

- Intake Agent (free-text description → structured build spec)
- Codegen Agent (sandboxed, feature-complete app generation)
- Persistence beyond in-memory (a restart loses all projects/chat history)
- Accounts/auth, streaming progress, delivery (git push/zip), cloud IaC

See the [backlog](../backlog.md) for sequencing, and
[`CHANGELOG.md`](../../CHANGELOG.md) for what shipped when.
