# Design: Chat History Persistence

- **Backlog item**: [`docs/backlog.md`](../backlog.md) — # 3
- **Status**: implemented

## Summary

Move the orchestrator's projects and chat history from in-memory Maps to
Postgres, and have the web UI load a project's real history instead of
only what accumulated client-side since the page was last loaded. This
pulls a piece of Phase 3 ("persistence") forward, the same way project
scaffolding pulled forward part of Phase 1 — done because it's now
blocking a concrete, requested feature, not because Phase 3 is starting
early in general.

## Feature-set impact

Selecting a project shows its actual past conversation, including after
an orchestrator restart or a page reload — not just messages sent since
the page loaded. `docs/blueprints/features.md`'s "Chat, scoped per
project" section changes from "in-memory only... lost on restart" to
persisted.

## Architecture impact

First real persistence in the orchestrator. Clean fit: `ProjectStore` and
`ChatSessionStore` ([`projectStore.ts`](../../packages/orchestrator/src/projectStore.ts),
[`chatStore.ts`](../../packages/orchestrator/src/chatStore.ts)) are
already interfaces — this adds a second implementation of each, backed
by Postgres, wired as the default in `server.ts`. The in-memory
implementations stay as-is for the existing fast unit tests.

New: `packages/orchestrator/docker-compose.yml` runs Postgres for local
dev — separate from `stack-spec/template/docker-compose.yml`, which is
for *generated apps*, not this builder tool. New endpoint:
`GET /api/projects/:id/messages`.

## Components affected

- [`orchestrator`](../blueprints/components/orchestrator.md) — new
  `src/db.ts` (pool + schema init), `src/postgresProjectStore.ts`,
  `src/postgresChatStore.ts`; `app.ts` gets the new messages endpoint;
  `server.ts` wires Postgres as the default backing store.
- `packages/web` — `App.tsx` fetches a project's history on selection
  instead of relying solely on the client-side mirror.

## Design

### Local Postgres (`packages/orchestrator/docker-compose.yml`)

One `postgres:16` service, credentials/db name fixed for local dev
(`app_builder`/`app_builder`/`app_builder`), port 5432. Orchestrator
connects via `DATABASE_URL` (new required env var, e.g.
`postgres://app_builder:app_builder@localhost:5432/app_builder`).

### Schema (`src/db.ts`)

Idempotent `CREATE TABLE IF NOT EXISTS` run at startup — no migration
framework, two tables:

```sql
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  stage TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  workspace_path TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id SERIAL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  role TEXT NOT NULL,
  content TEXT,
  tool_call_id TEXT,
  tool_name TEXT,
  tool_calls TEXT, -- JSON-stringified ToolCall[], nullable
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`tool_calls` is stored as a JSON string in a plain `TEXT` column (not
`jsonb`) — avoids driver-specific JSONB (de)serialization for a column
that's never queried by content, only round-tripped.

### `postgresProjectStore.ts` / `postgresChatStore.ts`

Straight implementations of the existing `ProjectStore`/`ChatSessionStore`
interfaces using the `pg` package (`Pool`), no ORM — the schema is two
tables, an ORM would be pure overhead. `ChatSessionStore.get()` also
backs the new endpoint directly (same method, no new store method
needed).

### `app.ts` (new route)

`GET /api/projects/:id/messages` → 404 if the project doesn't exist,
otherwise `{ messages: ChatMessage[] }` via `chatStore.get(id)`.

### `packages/web/src/App.tsx`

On `selectedProjectId` change, fetch `GET /api/projects/:id/messages` and
populate `messagesByProject[id]` from the response before rendering,
instead of only accumulating messages sent during the current page load.

### Testing

Automated `npm test` keeps using the in-memory stores via fakes — it must
not require Postgres to be running. The new Postgres-backed stores are
verified manually against a real local Postgres (`docker compose up -d`
in `packages/orchestrator`), the same way `scaffold.ts`'s Docker
execution and the Codegen Agent's real runs are verified manually rather
than in the automated suite.

## Out of scope

- Migrating away from `CREATE TABLE IF NOT EXISTS` to a real migration
  tool — revisit if the schema needs to evolve non-trivially.
- Any auth/multi-tenancy on top of persistence (still no accounts).
- Deleting/archiving projects or messages.
