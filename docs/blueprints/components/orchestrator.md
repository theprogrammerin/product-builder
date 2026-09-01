# Component Blueprint: `packages/orchestrator`

## Purpose

Backend for the hosted product. Today: a thin vertical slice — project
registry (with on-disk scaffolding) + chat passthrough to GLM — proving
the web plumbing works before any agent logic exists. Long term: also
runs the Intake/Codegen agents, streams progress, persists projects, and
delivers generated apps. See the
[target architecture](../architecture.md#target-architecture).

## Key files

- [`src/app.ts`](../../../packages/orchestrator/src/app.ts) — Express app
  factory and all routes (kept separate from `server.ts` so tests can
  build an app without binding a port)
- [`src/server.ts`](../../../packages/orchestrator/src/server.ts) — loads
  `.env`, builds the real `GlmClient`, starts listening
- [`src/projectStore.ts`](../../../packages/orchestrator/src/projectStore.ts) —
  `Project` model (including `workspacePath`), the fixed `PROJECT_STAGES`,
  in-memory store
- [`src/chatStore.ts`](../../../packages/orchestrator/src/chatStore.ts) —
  in-memory conversation history, keyed by project id
- [`src/scaffold.ts`](../../../packages/orchestrator/src/scaffold.ts) —
  copies [`stack-spec/template/`](../../../stack-spec/template) to a
  fresh `<PROJECT_FILES_DIR>/<projectId>/` directory on project creation

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | GLM config status (`baseUrl`/`model`, no secrets) |
| GET | `/api/projects` | list projects |
| POST | `/api/projects` | create a project (`{ name }`); scaffolds its workspace first, stage defaults to `ideation`; `500 scaffold_failed` if scaffolding fails (nothing is stored in that case) |
| PATCH | `/api/projects/:id/stage` | set a project's stage; 400 if not one of `PROJECT_STAGES`, 404 if the project doesn't exist |
| POST | `/api/chat` | `{ projectId, message }` → `{ reply, finishReason }`; 400 on missing fields, 404 on an unknown `projectId` |

## Known limitations

- Everything is in-memory — restarting the process loses all projects and
  chat history (scaffolded files on disk survive a restart, but the
  `Project` record pointing at them does not).
- `/api/chat` is synchronous/non-streaming; no SSE/WebSocket yet.
- No auth — any caller can read or write any project.
- No Intake/Codegen agents behind `/api/chat` — it's a direct GLM
  passthrough with a static system prompt.
- Scaffolding is a one-time, synchronous file copy at creation — no
  regeneration or update path yet.

## Tests

- [`test/app.test.ts`](../../../packages/orchestrator/test/app.test.ts) —
  API tests (supertest + a mocked `LLMClient` and a fake, disk-free
  scaffold function) covering health, project CRUD (including scaffold
  failure → 500, nothing stored), stage updates, and chat history.
- [`test/scaffold.test.ts`](../../../packages/orchestrator/test/scaffold.test.ts) —
  exercises the real `fs.cp` copy against temp directories: copies the
  tree, creates `PROJECT_FILES_DIR` if missing, throws instead of
  overwriting an existing destination.
