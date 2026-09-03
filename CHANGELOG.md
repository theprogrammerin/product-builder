# Changelog

Notable changes to this project, newest first. Add an entry here whenever
a feature lands. [`docs/blueprints/features.md`](docs/blueprints/features.md)
is the current-state summary these entries roll up into — update both
together.

## Unreleased

### Debug Agent — `/debug` (feature request #11)

A generated project can now be fixed, not just built. `/debug
<description>` investigates a reported problem in an already-built
project (or, with no description, runs a general health check); `/debug`
reuses the Codegen Agent's tool-calling loop in two scoped passes
(backend, then frontend) rather than duplicating it. Every real issue it
finds and fixes gets logged into *that project's own* `docs/backlog.md`
Bugs table, following that project's own copy of the mandatory Bug
workflow — the same discipline this repo holds itself to.

- `packages/debug-agent` (new): `runDebugAgent()` — assembles initial
  context (both sides' current test status, plus live container logs if
  the project is running via the Run Agent), runs a backend pass then a
  frontend pass, re-verifies both sides for real, and reports `fixed`
  only if both fully pass (an honest signal: a specific reported bug can
  be genuinely fixed while an unrelated, pre-existing failure elsewhere
  correctly keeps `fixed: false`).
- `packages/codegen-agent`: small, additive `toolDefinitions?` override
  added to `runCodegenLoop`'s `RunOptions` (default: the existing
  `TOOL_DEFINITIONS`, every existing caller unaffected) — needed because
  the Debug Agent's file-tools root is the whole project (so it can reach
  `CLAUDE.md`/`docs/backlog.md`), not just `backend/`/`frontend/`, making
  the stock tool descriptions actively wrong for it.
- `packages/orchestrator`: new `/debug` chat command, structurally
  identical to `/proceed` (ack, interim `[debug]` narration, terminal
  `[debug:done]`/`[debug:failed]`), pulling the project's live component
  list from `runStore` when the Run Agent has it running.
- Bug #8 (the scaffolding template's own `CLAUDE.md`/`docs/backlog.md`
  never received the Bug workflow section this repo added to itself)
  fixed as a hard prerequisite — every generated project now ships with
  it.
- Verified live 2026-09-03: a real backend bug (a dropped field in a
  controller's permitted params, breaking 2 of 21 rspec examples) was
  found, fixed, and logged correctly by a real LLM run against an
  already-built generated project — a two-file, surgical footprint, no
  design doc created (correctly, for a small fix), no unrelated changes.
- Design record: [`docs/designs/debug-agent.md`](docs/designs/debug-agent.md)

### Run Agent — `/run` and `/stop` (feature request #10)

A generated project can finally be seen running, not just verified by its
test suite. Once a build finishes writing its app, the Run Agent starts
it live automatically — concurrently with final verification, not after
it — and `/run`/`/stop` give manual control any time afterward. Verified
live 2026-09-03 against a real, previously-built generated project: real
Docker, dynamically allocated ports, both components reachable over real
HTTP, a stop → restart cycle confirmed fast and data-preserving.

- `packages/run-agent` (new): discovers a project's exposable components
  straight from its own `docker-compose.yml` (any service with a
  `${<NAME>_HOST_PORT}` port placeholder) — a one-to-many
  `project → components` mapping, not a fixed backend/frontend pair —
  allocates each a free host port, migrates the database, brings the
  stack up, and health-checks every URL.
- `packages/orchestrator`: new `/run`/`/stop` chat commands; the
  frontend codegen phase's code-writing loop is now split from its final
  verify step so the Run Agent's `start()` can run concurrently with
  verification instead of after it. New `running_instances`/
  `running_components` Postgres tables (`runStore.ts`/
  `postgresRunStore.ts`).
- `stack-spec/template/docker-compose.yml`: `rails`/`frontend` now
  publish a host port via an env var the Run Agent sets per invocation
  (`docker compose run --rm`, the Codegen Agent's own usage, is
  unaffected — it never publishes declared ports at all).
- Two real bugs found only by running this live (not by unit tests, which
  mock Docker): `docker compose up -d` doesn't wait for MySQL to actually
  be ready, just for its container to start — fixed with a real Compose
  healthcheck + `depends_on: condition: service_healthy`; the generated
  backend's `Gemfile` never included a web server gem, unnoticed until
  now because verification never actually booted `rails server` — fixed
  by adding `puma`.
- Bug #5 (`react-dom`/`react-native-web` missing from the frontend
  template, blocking `expo start --web`) fixed as a hard prerequisite of
  this feature.
- Design record: [`docs/designs/run-deploy-agent.md`](docs/designs/run-deploy-agent.md)

### Phase 3, Milestone 1 — `/build` wires the Intake + Codegen Agents into chat (feature request #7)

A chat message starting with `/build <description>` now actually
generates and verifies real backend code — no more CLI-only agents.
Verified end-to-end through the real browser UI 2026-09-02: a task-
tracker description went from `/build` to a passing `Task` resource (19
examples, 0 failures), with live progress visible via polling and the
agent self-correcting a namespace mismatch, a serializer quirk, and a
typo along the way.

- `packages/orchestrator`: `/api/chat` branches on a `/build` prefix,
  calling `runIntake`/`runCodegenAgent` (both agents' first real
  consumer beyond their own CLIs) in-process against the project's
  scaffolded workspace. The build runs as a fire-and-forget promise —
  the HTTP response is just an immediate ack — posting further
  `[build]`/`[build:done]`/`[build:failed]`/`[build:question]`-tagged
  chat messages as it progresses. Guarded against a second concurrent
  `/build` for the same project.
- `packages/codegen-agent`: extracted `runCodegenAgent()` (loop + final
  `bundle exec rspec` verification) out of `cli.ts` so the CLI and the
  orchestrator share the same tested code.
- `packages/web`: detects a `/build` submission and polls
  `GET /api/projects/:id/messages` every 4s while one is in flight,
  stopping once a terminal-tagged message arrives — plain HTTP polling,
  not real streaming.
- The chat system prompt (from bug #1's fix) now points users at `/build`
  instead of just saying app generation isn't available.
- Design record: [`docs/designs/wire-agents-into-chat.md`](docs/designs/wire-agents-into-chat.md)

### Multi-resource support (feature request #6)

Both agents were hard-limited to one resource per run. Now an arbitrary
number of related resources — not just two — can be described and built
in one pass, verified with real Docker/Rails runs on a 2-resource
(List/Item) and a 3-resource (List/Item/Comment) case: 31 and 36 examples
respectively, 0 failures, both converging comfortably under their scaled
iteration caps.

- `packages/intake-agent`: system prompt now allows repeated
  `## Resource` blocks plus an `## Associations` section
  (`belongs_to`/`has_many`/`has_one`); multi-resource is no longer by
  itself a reason to ask a clarifying question — only genuinely missing
  or unresolvable (e.g. circular) relationships are.
- `packages/codegen-agent`: system prompt's required sequence now builds
  every resource in a spec, in dependency order, before running the full
  suite once; `DEFAULT_MAX_ITERATIONS` (a flat 25) is replaced by
  `defaultMaxIterations(buildSpec)`, which scales with how many
  `## Resource` headings the spec contains (`max(25, resourceCount * 20)`)
  — a cheap heading count, not a real parse.
- Design record: [`docs/designs/multi-resource-support.md`](docs/designs/multi-resource-support.md)

### Bug fix: Intake Agent sometimes failed outright on an empty model response (bug #2)

- `runIntake` now retries once, silently, if the model's response comes
  back empty before giving up — observed completion-token usage for the
  *same* input varied from ~500 to ~2600 tokens purely from this model's
  hidden reasoning, so an empty response looked like transient variance,
  not a systematic problem, and a single retry recovers it in practice.
  Still one-shot from the user's point of view — no conversation loop,
  just one internal retry on a truly empty result.
- Raised default `maxTokens` 4096 → 8192, as further headroom against the
  same variance.
- The CLI now prints a plain, actionable message if both calls come back
  empty, instead of a raw stack trace.

### Phase 2 — Intake Agent (feature request #5)

First slice: a CLI that turns a free-text product description into the
same markdown build-spec file the Codegen Agent already reads — no JSON,
no schema, no parser on either side. Verified against the real GLM
endpoint 2026-09-02 on both the spec path and the clarifying-question
path.

- Add `packages/intake-agent`: `runIntake` makes one `llmClient.chat()`
  call (no tool-calling loop) and returns either a markdown spec or a
  clarifying question, distinguished only by a `QUESTION:` first-line
  marker — not a parser.
- Change `packages/codegen-agent`'s `--spec` handling: `loadBuildSpec`
  now reads the file as plain text instead of `JSON.parse`-ing it into a
  `BuildSpec` object, since the loop only ever re-serialized it into a
  text prompt message anyway. Backward compatible — any existing
  hand-written JSON spec still works, just as literal text now.
- Design record: [`docs/designs/intake-agent-milestone-1.md`](docs/designs/intake-agent-milestone-1.md)

### Bug fix: chat's "not built yet" refusal leaked reasoning-style narration (bug #1)

- Chat's system prompt only said "be direct about what isn't built yet,"
  leaving the model to invent its own phrasing when asked to build/generate
  an app — it produced narrated, reasoning-style refusals (e.g. "I don't
  want to hand you a fake URL, so I'll skip that part") instead of a clean
  product message.
- Fix: `SYSTEM_PROMPT` in `packages/orchestrator/src/app.ts` now explicitly
  instructs one short, plain sentence for that case — no hedging, no
  reasoning out loud. No capability or architecture change; chat still has
  no app-generation logic behind it.

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
