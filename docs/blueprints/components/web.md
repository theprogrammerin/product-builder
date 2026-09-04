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

## Chat rendering

A message matching `TOOL_CALL_LINE_PATTERN` (`"[build] → ..."`/`"[debug] →
..."` — the shape `formatToolCall()` on the orchestrator side produces,
see bug #14) renders as a small, compact metadata line (`.chat-tool-call`
— monospace, no bubble background/padding, tag prefix stripped) in its
natural chronological position in the log, instead of a full chat bubble.
Everything else (the model's own narration, terminal results) still
renders as a normal `.chat-message` bubble. Fixed as bug #16 — these were
originally full-size bubbles, which felt too heavy for what's really just
a running activity log.

## State

- Plain React `useState` — no state-management library. One page, kept
  deliberately simple; this is not subject to the Zustand pick locked for
  *generated* apps (see [`stack-spec` blueprint](./stack-spec.md)).
- `selectedProjectId`: persisted to `localStorage` (browser-scoped) so a
  page reload reselects the last-viewed project instead of always
  defaulting to the first one in the list; falls back to the first
  project if the stored id is no longer in the fetched list (feature #15).
- `messagesByProject`: a client-side cache of conversation history, keyed
  by project id. The first time a project is selected, its history is
  fetched from `GET /api/projects/:id/messages` (persisted in Postgres)
  and used to seed the cache; messages sent afterward are appended
  locally rather than re-fetched.
- `buildingProjects`: which projects currently have a `/build`/`/proceed`/
  `/debug` in flight. Set right after such a submission (unless the reply
  is itself a terminal tag, e.g. the empty-description guidance), *and*
  re-derived from persisted history — on the initial history load for a
  project, and whenever "Auto-refresh" is switched on — via
  `hasPendingWork()` (see bug #11 below). Drives a polling `useEffect`
  (`GET /api/projects/:id/messages` on a timer, currently-selected project
  only) that appends new tail messages and clears the flag once every
  outcome that was actually announced (build/run/debug) has a terminal
  tag — see [wire-agents-into-chat.md](../../designs/wire-agents-into-chat.md).
  Plain HTTP polling, not SSE/WebSocket.
- `hasPendingWork(messages)` / `isPendingByLastTag()`: judges each track
  (build/run/debug) independently by its **most recent** tag in history,
  not by whether a terminal tag has ever appeared anywhere — a project's
  history spans multiple rounds over its lifetime, and an old resolved
  round's terminal tag must not poison detection for a newer one still in
  progress. Fixed as bug #11 (previously a whole-history `.some()` check,
  which meant polling stopped on the first tick after almost any
  `/proceed`/`/debug` past a project's first).
- `pollingEnabled` / `pollIntervalMs`: user-controlled — an "Auto-refresh"
  checkbox and (when checked) an interval `<select>` above the chat log
  gate/parameterize the polling `useEffect` above. Both persist to
  `localStorage` (browser-scoped, not per-project/account). See
  [polling-toggle.md](../../designs/polling-toggle.md).
- `progressByProject`: a client-side cache of each project's live LLM
  call status, fetched from `GET /api/projects/:id/progress` on the same
  timer/tick as message polling above (same gating: `pollingEnabled` and
  `buildingProjects`). Rendered as a small footer below the message input
  — `"<Agent> — sent X / received Y tokens"`, plus `" · working... Ns"`
  while a call is in flight (`callStartedAt !== null`). See
  [token-usage-reporting.md](../../designs/token-usage-reporting.md)'s
  Amendment section.

## Known limitations

- No routing (single page).
- No automated tests yet — verified manually through the actual browser
  for the `/build` flow (see the design record's Outcome section).
- History is fetched once per project per page load (tracked via
  `loadedHistoryFor`) — a message added by another client/tab wouldn't
  appear without a full reload.
- Build progress polling only runs for the currently-selected project —
  switching away mid-build and back, or reloading the page, now correctly
  resumes it (bug #11's fix) as long as the persisted history still shows
  a track pending.
- Turning "Auto-refresh" off fully stops polling — an in-flight build's
  progress and result won't appear until it's turned back on or the page
  is reloaded (a reload re-fetches full history regardless of the
  toggle). The token-usage footer is gated the same way and freezes too.
- The footer's elapsed-time heartbeat only updates once per poll tick
  (no separate 1s ticker) — matches the actual polling cadence but can
  look coarse at longer intervals (e.g. 30s).

## Running it

```bash
npm run dev --workspace @app-builder/web   # http://localhost:5173
```

Requires the orchestrator running on port 4000, which in turn needs its
Postgres up (`docker compose up -d` in `packages/orchestrator`):

```bash
npm run dev --workspace @app-builder/orchestrator
```
