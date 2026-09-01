# Feature Blueprint

Snapshot of what this project can actually do today. For where it's
headed, see [`docs/backlog.md`](../backlog.md); for how each
piece works, see the per-component docs under
[`components/`](./components/).

## Opinionated stack for generated apps

A locked set of libraries/versions, codegen guidelines, and a starting
structural skeleton that every project is built from.

- Locked versions: [`stack-spec/versions.yaml`](../../stack-spec/versions.yaml)
- Decision guidelines (one file per topic): [`stack-spec/guidelines/`](../../stack-spec/guidelines/)
- Starting skeleton, copied into every new project: [`stack-spec/template/`](../../stack-spec/template/)
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

## Project scaffolding

Creating a project also provisions a real starting codebase for it on
disk, copied verbatim from [`stack-spec/template/`](../../stack-spec/template/)
— deterministic, no LLM call. Every project starts byte-identical,
including its own copy of the same backlog/blueprint/design-doc/changelog
governance loop this repo follows, scoped to that project. Project
creation fails outright (`500 scaffold_failed`) if the copy fails.

- API: `POST /api/projects` now returns a `workspacePath`, and 500s on scaffold failure — [`scaffold.ts`](../../packages/orchestrator/src/scaffold.ts), [`app.ts`](../../packages/orchestrator/src/app.ts)
- Config: `PROJECT_FILES_DIR` (default `./generated-projects`)
- Not yet a runnable app — see [`stack-spec` blueprint](./components/stack-spec.md); making it one is Phase 1.

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
