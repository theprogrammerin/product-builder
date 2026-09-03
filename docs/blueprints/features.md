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

## Codegen Agent (CLI) — proven on multi-resource CRUD + associations

Given an already-scaffolded project and a build spec (hand-written or
from the Intake Agent), an LLM tool-calling loop writes and *actually
runs* real Rails backend code — inside Docker — until `bundle exec rspec`
genuinely passes, for one resource or several related ones in a single
run. First proven end-to-end 2026-09-02 (one resource, 21 examples);
extended to multiple resources 2026-09-02 (`List`/`Item`: 31 examples;
`List`/`Item`/`Comment`: 36 examples), building each resource in
dependency order with real foreign keys and associations — independently
following this repo's own `error-handling.md`/`api-conventions.md`
guidelines throughout.

- CLI: `codegen-agent --workspace <path> --spec <path>` — [component blueprint](./components/codegen-agent.md)
- Usable standalone (a developer runs the CLI by hand against a project's
  `workspacePath`) or as a library — the orchestrator's `/build` chat
  flow (below) calls it directly
- Scope: backend only — no auth, MongoDB, Sidekiq, or frontend generation
  yet; associations limited to `belongs_to`/`has_many`/`has_one` (no
  many-to-many yet)
- Iteration budget scales with how many resources the spec describes,
  not a flat constant
- The model's own "done" is never trusted — a final `bundle exec rspec`
  run is what actually certifies success, every time

## Intake Agent (CLI) — free-text description to build spec

Given a plain-English description (e.g. "a task tracker where each task
has a title and a due date," or "a List that has many Items"), running
the Intake Agent CLI produces the same markdown build-spec file the
Codegen Agent's `--spec` flag reads directly — no JSON, no schema, any
number of related resources. If the description doesn't contain enough
to build from (no clear resource/fields, or a relationship it can't put
in a buildable order), it prints one clarifying question and exits
instead of guessing. Verified against the real GLM endpoint on the spec
path, the clarifying-question path, and multi-resource specs (2 and 3
resources) 2026-09-02.

- CLI: `intake-agent --description "<text>" --out <path-to-spec.md>` —
  [component blueprint](./components/intake-agent.md)
- Usable standalone, chained by hand into the Codegen Agent CLI
  (`intake-agent --description "..." --out spec.md && codegen-agent --workspace <path> --spec spec.md`),
  or as a library — the orchestrator's `/build` chat flow (below) calls
  it directly, in memory, no file involved
- Scope: any number of resources, `belongs_to`/`has_many`/`has_one`
  associations only — no entities beyond that, roles, workflows, or
  screens yet
- One-shot: a vague description gets one clarifying question, not a
  back-and-forth conversation

## Chat, scoped per project — persisted

Send a message to a selected project; the orchestrator keeps that
project's conversation history in Postgres and replays it as context on
every turn. Selecting a project in the UI loads its real past
conversation, including after an orchestrator restart or a page reload.

- API: `POST /api/chat` (`{ projectId, message }` → `{ reply, finishReason }`, 404 on an unknown project); `GET /api/projects/:id/messages` returns the persisted history — [`app.ts`](../../packages/orchestrator/src/app.ts)
- Storage: Postgres, via `postgresChatStore.ts`/`postgresProjectStore.ts` — both projects and chat history survive a restart
- UI: single-page chat log + input, fetches history on project selection — [`App.tsx`](../../packages/web/src/App.tsx)
- Ordinary messages go straight to the configured GLM model with a static
  system prompt — no app-generation logic behind them. See `/build` below
  for what does generate something.

## `/build <description>` — real code generation from chat

Send `/build <description>` in a project's chat and the orchestrator
actually builds it: the Intake Agent turns the description into a spec,
then — if it's not ambiguous — the Codegen Agent generates and verifies
real backend code against that project's own workspace, all inside
Docker. Verified end-to-end through the real browser UI 2026-09-02: a
task-tracker description went from `/build` to a passing `Task` resource
(19 examples, 0 failures) with live progress visible the whole way,
including the agent self-correcting a namespace mismatch, a serializer
quirk, and a typo along the way.

- The assistant acknowledges immediately, then posts further messages as
  the build progresses (the Codegen Agent's own narration — not a
  synthetic progress bar) and a final pass/fail result — the web UI polls
  for these while a build is in flight, so it doesn't look stuck even
  though there's no real streaming yet.
- If the description is ambiguous, the reply is the Intake Agent's
  clarifying question — send another `/build` with more detail.
- Only one build runs per project at a time — a second `/build` while one
  is in flight gets a "please wait," not a conflicting run.
- **Known limitations**: no accounts, no real SSE/WebSocket streaming
  (HTTP polling stands in for this milestone), no delivery (git push/
  zip), and no durable job queue — an orchestrator restart mid-build
  loses that result.
- Design record: [`wire-agents-into-chat.md`](../designs/wire-agents-into-chat.md)

## Running a generated project — `/run` and `/stop`

Once a project's build has finished writing its app, it starts running
automatically — no separate "now go run it" step. `/run` and `/stop` give
manual control any time after that:

- `/run`: starts the project's app (or reports its current live URLs if
  it's already running — a safe way to ask "is it running?" without
  restarting anything). Replies `[run:live] Your app is running —
  <component>: <url>, ...` listing every component the project actually
  has, not a fixed backend/frontend pair.
- `/stop`: stops the running containers, freeing their ports. The
  project's code and data are untouched — this only pauses the
  containers, it doesn't remove them or their volumes, so a follow-up
  `/run` restarts quickly without re-running migrations against an empty
  database.
- If `/run` fails (e.g. a port conflict, a migration error), the reply is
  `[run:failed] <reason>` — the underlying containers, if any came up,
  are left running for inspection rather than torn down silently.
- Running and verifying a freshly-built app happen at the same time, not
  one after the other: once the app is fully written, its final test
  suite and the Run Agent's startup both begin immediately, so a live
  preview doesn't wait on every test being confirmed passing first.
- Design record: [`run-deploy-agent.md`](../designs/run-deploy-agent.md)

## Investigating and fixing issues — `/debug`

`/debug [description]` investigates an already-built project — a
reported problem, or (with no description) a general health check across
both sides — finds the root cause, fixes it, and re-verifies for real
before reporting back:

- With a description: investigates that specific report (e.g.
  `/debug toggling a task's done status doesn't save`).
- With no description: a general sweep — current test status on both
  sides, plus (if the project is currently running via the Run Agent)
  its live components' recent logs.
- Every real issue it finds and fixes gets logged as a row in **that
  project's own `docs/backlog.md` "Bugs" table** — the same governance
  copy every project is scaffolded with (feature #1) — following that
  project's own `CLAUDE.md` Bug workflow: a small, self-contained fix
  goes straight to `fixed` with no design doc; anything larger gets one,
  copied from that project's own `docs/designs/TEMPLATE.md`. The
  generated project ends up with a real bug history, not silent patches.
- Replies `[debug:done] <summary>` or `[debug:failed] <summary>` — the
  latter can mean either the specific issue wasn't actually resolved, or
  (honestly) that the reported issue *was* fixed but some other,
  unrelated part of the app still doesn't pass — re-verification always
  covers both sides' full test suites, not just what was touched.
- Guarded the same way `/build`/`/proceed` are — one code-mutating
  operation per project at a time.
- Verified live 2026-09-03: a real backend bug (a dropped field in a
  controller's permitted params) was found, fixed, and logged correctly
  by a real LLM run — see design doc.
- Design record: [`debug-agent.md`](../designs/debug-agent.md)

## Health check

- `GET /api/health` reports the configured GLM `baseUrl`/`model` without
  leaking the API key — [`app.ts`](../../packages/orchestrator/src/app.ts)

## Not yet built

- Codegen Agent: auth, MongoDB, Sidekiq, frontend generation,
  many-to-many (`has_and_belongs_to_many`) associations
- Intake Agent beyond one-shot clarification (multi-turn conversation)
- Accounts/auth, real streaming (SSE/WebSocket — `/build` uses plain HTTP
  polling for now), delivery (git push/zip), a durable job queue for
  `/build`, cloud IaC

See the [backlog](../backlog.md) for sequencing, and
[`CHANGELOG.md`](../../CHANGELOG.md) for what shipped when.
