# Component Blueprint: `packages/orchestrator`

## Purpose

Backend for the hosted product. Today: project registry + chat history
(both persisted in Postgres) with on-disk scaffolding of each new
project, and a direct GLM chat passthrough — proving the web plumbing
works before any agent logic exists. Long term: also runs the
Intake/Codegen agents, streams progress, and delivers generated apps. See
the [target architecture](../architecture.md#target-architecture).

## Key files

- [`src/app.ts`](../../../packages/orchestrator/src/app.ts) — Express app
  factory and all routes (kept separate from `server.ts` so tests can
  build an app without binding a port)
- [`src/server.ts`](../../../packages/orchestrator/src/server.ts) — loads
  `.env`, connects to Postgres and ensures the schema, builds the real
  `GlmClient`, starts listening
- [`src/db.ts`](../../../packages/orchestrator/src/db.ts) — `pg` pool +
  idempotent schema init (`projects`, `chat_messages` tables)
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
| POST | `/api/chat` | `{ projectId, message }` → `{ reply, finishReason }`; 400 on missing fields, 404 on an unknown `projectId` |

## Known limitations

- Projects and chat history persist in Postgres, but scaffolded files on
  disk are tracked only by `workspacePath` — nothing reconciles the two
  if one is deleted out from under the other.
- `/api/chat` is synchronous/non-streaming; no SSE/WebSocket yet.
- No auth — any caller can read or write any project.
- No Intake/Codegen agents behind `/api/chat` — it's a direct GLM
  passthrough with a static system prompt.
- Scaffolding is a one-time, synchronous file copy at creation — no
  regeneration or update path yet.
- Schema is managed via idempotent `CREATE TABLE IF NOT EXISTS`, not a
  migration tool — fine for two tables, worth revisiting if that grows.

## Tests

- [`test/app.test.ts`](../../../packages/orchestrator/test/app.test.ts) —
  API tests (supertest + a mocked `LLMClient`, a fake disk-free scaffold
  function, and the in-memory stores) covering health, project CRUD
  (including scaffold failure → 500, nothing stored), stage updates, and
  chat history. Runs with no Postgres or Docker required.
- [`test/scaffold.test.ts`](../../../packages/orchestrator/test/scaffold.test.ts) —
  exercises the real `fs.cp` copy against temp directories: copies the
  tree, creates `PROJECT_FILES_DIR` if missing, throws instead of
  overwriting an existing destination.
- The Postgres-backed stores (`postgresProjectStore.ts`/
  `postgresChatStore.ts`) are verified manually against a real local
  Postgres (`docker compose up -d` in this directory), not in the
  automated suite — see
  [`chat-history-persistence.md`](../../designs/chat-history-persistence.md).
