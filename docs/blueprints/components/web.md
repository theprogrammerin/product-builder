# Component Blueprint: `packages/web`

## Purpose

The end-user interface: a single-page chat UI scoped to a selected
project, with a stage tracker next to it. Not governed by `stack-spec/` —
that spec locks the stack for *generated* apps, not this builder tool's
own UI.

## Key files

- [`src/App.tsx`](../../../packages/web/src/App.tsx) — the entire UI:
  project select + "new project" form, stage select, chat log, message
  input
- [`src/index.css`](../../../packages/web/src/index.css) — styling
- [`vite.config.ts`](../../../packages/web/vite.config.ts) — dev-server
  proxy of `/api` to the orchestrator at `http://localhost:4000`

## State

- Plain React `useState` — no state-management library. One page, kept
  deliberately simple; this is not subject to the Zustand pick locked for
  *generated* apps (see [`stack-spec` blueprint](./stack-spec.md)).
- `messagesByProject`: a client-side cache of conversation history, keyed
  by project id. The first time a project is selected, its history is
  fetched from `GET /api/projects/:id/messages` (persisted in Postgres)
  and used to seed the cache; messages sent afterward are appended
  locally rather than re-fetched.

## Known limitations

- No routing (single page).
- No automated tests yet.
- History is fetched once per project per page load (tracked via
  `loadedHistoryFor`) — a message added by another client/tab wouldn't
  appear without a full reload.

## Running it

```bash
npm run dev --workspace @app-builder/web   # http://localhost:5173
```

Requires the orchestrator running on port 4000, which in turn needs its
Postgres up (`docker compose up -d` in `packages/orchestrator`):

```bash
npm run dev --workspace @app-builder/orchestrator
```
