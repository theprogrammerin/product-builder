# Component Blueprint: `packages/orchestrator`

## Purpose

Backend for the hosted product. Today: project registry + chat history
(both persisted in Postgres) with on-disk scaffolding of each new
project, ordinary chat as a direct GLM passthrough, and — as of
[wire-agents-into-chat.md](../../designs/wire-agents-into-chat.md) — a
`/build <description>` chat message that actually runs the Intake and
Codegen Agents against a project's workspace. Long term: accounts,
real streaming, and delivery. See the
[target architecture](../architecture.md#target-architecture).

## Key files

- [`src/app.ts`](../../../packages/orchestrator/src/app.ts) — Express app
  factory and all routes (kept separate from `server.ts` so tests can
  build an app without binding a port)
- [`src/server.ts`](../../../packages/orchestrator/src/server.ts) — loads
  `.env`, connects to Postgres and ensures the schema, builds the real
  `GlmClient`, starts listening
- [`src/db.ts`](../../../packages/orchestrator/src/db.ts) — `pg` pool +
  idempotent schema init (`projects`, `chat_messages`, `running_instances`,
  `running_components` tables)
- [`src/projectStore.ts`](../../../packages/orchestrator/src/projectStore.ts) —
  `Project` model (including `workspacePath`), the fixed `PROJECT_STAGES`,
  and the `ProjectStore` interface (async)
- [`src/postgresProjectStore.ts`](../../../packages/orchestrator/src/postgresProjectStore.ts) —
  the real, Postgres-backed `ProjectStore` (used by default in `server.ts`)
- [`src/chatStore.ts`](../../../packages/orchestrator/src/chatStore.ts) —
  the `ChatSessionStore` interface (async) + an in-memory implementation
  (used by default in tests)
- [`src/postgresChatStore.ts`](../../../packages/orchestrator/src/postgresChatStore.ts) —
  the real, Postgres-backed `ChatSessionStore` (used by default in `server.ts`)
- [`src/scaffold.ts`](../../../packages/orchestrator/src/scaffold.ts) —
  copies [`stack-spec/template/`](../../../stack-spec/template) to a
  fresh `<PROJECT_FILES_DIR>/<projectId>/` directory on project creation
- `src/app.ts`'s `defaultRunCodegenPhase` — the real `/proceed`
  implementation: backend via `runCodegenAgent`
  ([Codegen Agent](./codegen-agent.md)), then the frontend's code-writing
  loop (`runCodegenLoop`) split from its verify step so the Run Agent can
  start at the same instant as final verification, not after it
- [`src/runStore.ts`](../../../packages/orchestrator/src/runStore.ts) —
  `RunInstance`/`RunComponent` types (a one-to-many project → components
  mapping) and the `RunStore` interface (async) + an in-memory
  implementation (used by default in tests)
- [`src/postgresRunStore.ts`](../../../packages/orchestrator/src/postgresRunStore.ts) —
  the real, Postgres-backed `RunStore` (used by default in `server.ts`)
- [`docker-compose.yml`](../../../packages/orchestrator/docker-compose.yml) —
  local Postgres for the orchestrator's own persistence (unrelated to
  `stack-spec/template/docker-compose.yml`, which is for generated apps)

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | GLM config status (`baseUrl`/`model`, no secrets) |
| GET | `/api/projects` | list projects |
| POST | `/api/projects` | create a project (`{ name }`); scaffolds its workspace first, stage defaults to `ideation`; `500 scaffold_failed` if scaffolding fails (nothing is stored in that case) |
| PATCH | `/api/projects/:id/stage` | set a project's stage; 400 if not one of `PROJECT_STAGES`, 404 if the project doesn't exist |
| GET | `/api/projects/:id/messages` | persisted chat history for a project; 404 if the project doesn't exist |
| POST | `/api/chat` | `{ projectId, message }` → `{ reply, finishReason }`; 400 on missing fields, 404 on an unknown `projectId`. `/build`, `/proceed`, `/run`, and `/stop` trigger real work instead of a chat passthrough — see below. |

### `/build` → `/proceed`: Intake, review, then Codegen

`/build <description>` runs the Intake Agent and posts its proposed plan
as `[build:review]` (or `[build:question]` if it needs more detail) —
nothing is built yet. `/proceed` then runs the Codegen Agent (backend,
then frontend) against that plan, in-process, against the project's own
`workspacePath`. The HTTP response to `/proceed` is just an immediate
acknowledgement; the actual work happens in an un-awaited promise,
posting further chat messages as it progresses:

- `[build] <text>` — interim/informational (ack, "starting the
  frontend," the Codegen Agent's own narration).
- `[build:question] <text>` — terminal: Intake Agent needs more
  information (or the `/build` had no description at all).
- `[build:review] <text>` — terminal: a plan is ready for `/proceed`.
- `[build:done] <text>` — terminal: both `bundle exec rspec` and `npx
  jest` passed.
- `[build:failed] <text>` — terminal: tests didn't pass, hit the
  iteration cap, or something threw.

Only one build runs per project at a time — an in-memory `Set<projectId>`
in `createApp`'s closure rejects a second `/proceed` (or `/build`) for the
same project while one is in flight with a "please wait" reply. See
[wire-agents-into-chat.md](../../designs/wire-agents-into-chat.md) and
[frontend-generation.md](../../designs/frontend-generation.md).

### `/run` and `/stop`: the Run Agent

Once the frontend's code-writing loop converges (backend already
verified passing), the Run Agent's `start()` fires at the same instant as
final verification — not after it — via the [Run Agent](./run-agent.md).
Its outcome is posted independently of the build's:

- `[run] Starting your app...` — non-terminal; a `[run:live]`/
  `[run:failed]` is still owed.
- `[run:live] <text>` — terminal: every discovered component is up and
  reachable; lists each one's URL.
- `[run:failed] <text>` — terminal: something in the start sequence
  failed (port allocation, migration, a component that never became
  reachable).

`/run` (typed directly) starts the app the same way, or reports its
current live URLs as a no-op if it's already running; `/stop` stops the
containers (data and code untouched). Both are guarded by a separate
`runningOps` set against racing each other or the build's own automatic
trigger for the same project.

## Known limitations

- Projects and chat history persist in Postgres, but scaffolded files on
  disk are tracked only by `workspacePath` — nothing reconciles the two
  if one is deleted out from under the other.
- `/api/chat` itself is synchronous/non-streaming; `/build`'s progress
  messages are polled by the client (`packages/web`), not pushed —
  real SSE/WebSocket streaming is still deferred.
- No auth — any caller can read or write any project.
- `/build`'s concurrency guard and the build itself are per-process, in
  memory — an orchestrator restart mid-build loses that result and resets
  the guard. No durable job queue yet.
- `running_instances`/`running_components` are persisted, but nothing
  reconciles them against reality if containers are stopped or removed
  outside the app — see [run-agent.md](./run-agent.md)'s Known limitations.
- Scaffolding is a one-time, synchronous file copy at creation — no
  regeneration or update path yet.
- Schema is managed via idempotent `CREATE TABLE IF NOT EXISTS`, not a
  migration tool — fine for two tables, worth revisiting if that grows.

## Tests

- [`test/app.test.ts`](../../../packages/orchestrator/test/app.test.ts) —
  API tests (supertest + a mocked `LLMClient`, a fake disk-free scaffold
  function, a fake `RunBuild`, and the in-memory stores) covering health,
  project CRUD (including scaffold failure → 500, nothing stored), stage
  updates, chat history, and `/build` (ack + interim + terminal messages,
  the concurrency guard, empty-description rejection, ordinary chat
  unaffected). Runs with no Postgres or Docker required — the real
  `defaultRunBuild` (and therefore a real Intake/Codegen Agent run) was
  verified manually through the actual browser UI, not in this suite; see
  the design record's Outcome section.
- [`test/scaffold.test.ts`](../../../packages/orchestrator/test/scaffold.test.ts) —
  exercises the real `fs.cp` copy against temp directories: copies the
  tree, creates `PROJECT_FILES_DIR` if missing, throws instead of
  overwriting an existing destination.
- The Postgres-backed stores (`postgresProjectStore.ts`/
  `postgresChatStore.ts`) are verified manually against a real local
  Postgres (`docker compose up -d` in this directory), not in the
  automated suite — see
  [`chat-history-persistence.md`](../../designs/chat-history-persistence.md).
