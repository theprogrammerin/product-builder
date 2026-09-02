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
- The backend half is a real `rails new --api` skeleton (bundle install
  still required); the frontend half is still a bare structural skeleton
  — see [`stack-spec` blueprint](./components/stack-spec.md).

## Codegen Agent (CLI) — proven on one CRUD resource

Given an already-scaffolded project and a hand-written build spec (e.g.
`{ "resource": "Task", "fields": [...] }`), an LLM tool-calling loop
writes and *actually runs* real Rails backend code — inside Docker —
until `bundle exec rspec` genuinely passes. First proven end-to-end
2026-09-02: model, migration, Blueprinter serializer, namespaced
controller with pagination, request + model specs — 21 examples, 0
failures, independently following this repo's own `error-handling.md`/
`api-conventions.md` guidelines.

- CLI: `codegen-agent --workspace <path> --spec <path>` — [component blueprint](./components/codegen-agent.md)
- CLI-only — no web UI or orchestrator integration yet; a developer runs
  it by hand against a project's `workspacePath`
- Scope: single resource, backend only — no auth, MongoDB, Sidekiq, or
  frontend generation yet
- The model's own "done" is never trusted — a final `bundle exec rspec`
  run is what actually certifies success, every time

## Chat, scoped per project — persisted

Send a message to a selected project; the orchestrator keeps that
project's conversation history in Postgres and replays it as context on
every turn. Selecting a project in the UI loads its real past
conversation, including after an orchestrator restart or a page reload.

- API: `POST /api/chat` (`{ projectId, message }` → `{ reply, finishReason }`, 404 on an unknown project); `GET /api/projects/:id/messages` returns the persisted history — [`app.ts`](../../packages/orchestrator/src/app.ts)
- Storage: Postgres, via `postgresChatStore.ts`/`postgresProjectStore.ts` — both projects and chat history survive a restart
- UI: single-page chat log + input, fetches history on project selection — [`App.tsx`](../../packages/web/src/App.tsx)
- No app-generation logic behind it yet — messages go straight to the
  configured GLM model with a static system prompt.

## Health check

- `GET /api/health` reports the configured GLM `baseUrl`/`model` without
  leaking the API key — [`app.ts`](../../packages/orchestrator/src/app.ts)

## Not yet built

- Intake Agent (free-text description → structured build spec)
- Codegen Agent beyond a single resource: auth, MongoDB, Sidekiq,
  frontend generation, multi-resource specs
- Wiring the Codegen Agent into the orchestrator/web UI (still CLI-only)
- Accounts/auth, streaming progress, delivery (git push/zip), cloud IaC

See the [backlog](../backlog.md) for sequencing, and
[`CHANGELOG.md`](../../CHANGELOG.md) for what shipped when.
