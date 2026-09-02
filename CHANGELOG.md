# Changelog

Notable changes to this project, newest first. Add an entry here whenever
a feature lands. [`docs/blueprints/features.md`](docs/blueprints/features.md)
is the current-state summary these entries roll up into — update both
together.

## Unreleased

### Phase 1, Milestone 1 — Codegen Agent passes end-to-end (feature requests #2, #4)

First working slice of the Codegen Agent: given a scaffolded project and
a hand-written build spec, it writes and actually runs Rails backend code
until `bundle exec rspec` genuinely passes. Proven 2026-09-02 on a `Task`
CRUD resource — 21 examples, 0 failures — after 5 real runs, each fixing
a genuine bug:

- Add `packages/codegen-agent`: CLI, tool-calling loop, Docker-based
  execution (`docker compose run --rm rails <command>`), and a system
  prompt built from `stack-spec/versions.yaml` + `guidelines/*.md`.
- Add `list_files` (recursive) and `search_files` (grep-style regex)
  tools alongside `read_file`/`write_file`/`list_dir`/`run_command`, to
  cut down exploration iterations (feature request #4).
- Fix: the loop no longer treats an empty/no-tool-call response as "done"
  (run 1); generous `maxTokens` (4096), since this model spends tokens on
  hidden reasoning before visible output.
- Fix: `stack-spec/template/backend/Dockerfile` bakes in
  `build-essential`/`pkg-config`/`default-libmysqlclient-dev`/`git` at
  build time; `docker-compose.yml` adds a persistent `bundle_cache`
  volume — `docker compose run --rm`'s ephemeral containers meant nothing
  installed ad hoc via `run_command` ever persisted to the next command
  (run 1-2).
- Fix: dropped host port publishing from `docker-compose.yml` entirely —
  fixed host ports meant two projects' stacks could never run
  concurrently, or after a prior run's containers were left up (run 2);
  the CLI now also runs `docker compose down` after every run.
- **Biggest change**: `stack-spec/template/backend/` is now a real
  `rails new --api` + `rails generate rspec:install` output (generated
  inside the exact runtime image, with locked gems restored and
  `config.generators.orm = :active_record` set explicitly — Mongoid's
  presence otherwise hijacks `rails generate model` to default to
  Mongoid instead of MySQL/ActiveRecord). Removed most boilerplate/setup
  work from every future run's iteration budget (run 3).
- Design record: [`docs/designs/codegen-agent-milestone-1.md`](docs/designs/codegen-agent-milestone-1.md)

### Chat history persistence (feature request #3)

- Move the orchestrator's projects and chat history from in-memory Maps
  to Postgres: new `packages/orchestrator/docker-compose.yml` (local
  Postgres), `src/db.ts` (pool + schema init), and
  `postgresProjectStore.ts`/`postgresChatStore.ts` implementing the
  existing `ProjectStore`/`ChatSessionStore` interfaces (now async).
  Projects and chat both survive an orchestrator restart.
- Add `GET /api/projects/:id/messages`; the web UI fetches a project's
  real history the first time it's selected instead of only showing
  messages sent since the page loaded. (`packages/orchestrator/src/app.ts`,
  `packages/web/src/App.tsx`)
- Design record: [`docs/designs/chat-history-persistence.md`](docs/designs/chat-history-persistence.md)

### Phase 0.75 — Project scaffolding (feature request #1)

- Add `stack-spec/template/`: a structural-skeleton project (backend +
  frontend + `docker-compose.yml`) matching the locked stack, plus a full
  copy of this repo's own governance loop (`CLAUDE.md`, `docs/backlog.md`,
  `docs/blueprints/`, `docs/designs/TEMPLATE.md`, `CHANGELOG.md`) so any
  agent or human building features into a generated project follows the
  same discipline there. (`stack-spec/template/`)
- Add `packages/orchestrator/src/scaffold.ts`: copies the template into
  `<PROJECT_FILES_DIR>/<projectId>/` on project creation — deterministic,
  no LLM call. `POST /api/projects` now returns a `workspacePath` and
  500s with `scaffold_failed` (storing nothing) if the copy fails.
  (`packages/orchestrator/src/scaffold.ts`, `app.ts`, `projectStore.ts`)
- Design record: [`docs/designs/project-scaffolding.md`](docs/designs/project-scaffolding.md)

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
