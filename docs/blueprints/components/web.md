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
- `buildingProjects`: which projects currently have a `/build` in flight.
  Set right after a `/build` submission (unless the reply is itself a
  terminal `[build:...]` tag, e.g. the empty-description guidance).
  Drives a polling `useEffect` (`GET /api/projects/:id/messages` every 4s,
  currently-selected project only) that appends new tail messages and
  clears the flag once one matches `/^\[build:(done|failed|question)\]/`
  — see [wire-agents-into-chat.md](../../designs/wire-agents-into-chat.md).
  Plain HTTP polling, not SSE/WebSocket.

## Known limitations

- No routing (single page).
- No automated tests yet — verified manually through the actual browser
  for the `/build` flow (see the design record's Outcome section).
- History is fetched once per project per page load (tracked via
  `loadedHistoryFor`) — a message added by another client/tab wouldn't
  appear without a full reload.
- Build progress polling only runs for the currently-selected project;
  switching away mid-build and back won't resume live updates until a
  full page reload.

## Running it

```bash
npm run dev --workspace @app-builder/web   # http://localhost:5173
```

Requires the orchestrator running on port 4000, which in turn needs its
Postgres up (`docker compose up -d` in `packages/orchestrator`):

```bash
npm run dev --workspace @app-builder/orchestrator
```
