# Design: Polling on/off toggle + interval picker

- **Backlog item**: [`docs/backlog.md`](../backlog.md) — # 12
- **Status**: implemented — verified live in the browser 2026-09-03 (toggle
  on/off, interval dropdown appearing/disappearing, `localStorage`
  persistence across a reload, auto-scroll to the latest message, and the
  chat log's border removed)

## Summary

Add a manual "Auto-refresh" toggle to the web chat UI, and — only when
it's on — a dropdown to pick the polling interval. Today, polling for
`/build`/`/run`/`/debug` progress is fully automatic and fixed at 4s; this
gives the user direct control over both whether it runs and how often.

## Feature-set impact

Next to the chat, the user sees an "Auto-refresh" toggle (on by default)
and, only while it's on, an interval dropdown (2s / 4s / 10s / 30s,
default 4s). Turning the toggle off fully stops polling: if a
`/build`/`/run`/`/debug` is in flight, its progress and final result won't
appear until the user turns auto-refresh back on or reloads the page (a
reload still fetches full history immediately, independent of polling).
Both the toggle state and the chosen interval persist across reloads via
`localStorage`, scoped to the browser, not per-project or per-account.

## Architecture impact

No new components. Confined to `packages/web`:
[`components/web.md`](../blueprints/components/web.md)'s State section
gains two entries (`pollingEnabled`, `pollIntervalMs`) and a note that
turning auto-refresh off pauses in-flight progress until re-enabled or
reloaded.

## Components affected

- `packages/web` — [`src/App.tsx`](../../packages/web/src/App.tsx): new
  state, new UI controls, polling `useEffect` gated on the new state.
  [`components/web.md`](../blueprints/components/web.md): document the
  new state and the pause behavior.

## Design

**State** (`App.tsx`):

```ts
const POLL_INTERVAL_STORAGE_KEY = "app-builder:pollIntervalMs";
const POLLING_ENABLED_STORAGE_KEY = "app-builder:pollingEnabled";
const POLL_INTERVAL_OPTIONS_MS = [2000, 4000, 10000, 30000];
const DEFAULT_POLL_INTERVAL_MS = 4000;

const [pollingEnabled, setPollingEnabled] = useState<boolean>(() => {
  const stored = localStorage.getItem(POLLING_ENABLED_STORAGE_KEY);
  return stored === null ? true : stored === "true";
});
const [pollIntervalMs, setPollIntervalMs] = useState<number>(() => {
  const stored = Number(localStorage.getItem(POLL_INTERVAL_STORAGE_KEY));
  return POLL_INTERVAL_OPTIONS_MS.includes(stored) ? stored : DEFAULT_POLL_INTERVAL_MS;
});
```

Two small effects persist each to `localStorage` on change (wrapped in
`try/catch` — `localStorage` can throw in some browser contexts, and a
persistence failure shouldn't break the toggle itself).

The existing polling `useEffect` (currently keyed on
`BUILD_POLL_INTERVAL_MS`) changes its guard and its `setInterval` call:

```ts
useEffect(() => {
  if (!selectedProjectId || !buildingProjects[selectedProjectId] || !pollingEnabled) return;
  const projectId = selectedProjectId;
  const interval = setInterval(() => { /* unchanged body */ }, pollIntervalMs);
  return () => clearInterval(interval);
}, [selectedProjectId, buildingProjects, messagesByProject, pollingEnabled, pollIntervalMs]);
```

Turning the toggle on while a build is already in flight resumes polling
immediately (the effect re-runs because `pollingEnabled` is a dependency).
Changing the interval while polling is active restarts the interval timer
at the new cadence (same reason — `pollIntervalMs` is a dependency, so
React tears down and re-creates the `setInterval`).

**UI**: a small control row above or beside the message input —

```
[x] Auto-refresh   Every: [4s v]
```

- A checkbox (or equivalent toggle) bound to `pollingEnabled`.
- A `<select>` bound to `pollIntervalMs`, rendered only when
  `pollingEnabled` is true, options labeled "2s"/"4s"/"10s"/"30s".
- No dependency on whether a build is currently in flight — the controls
  are always visible, since the user may want to pre-set them before
  kicking off a `/build`.

No backend changes; this is a pure client-side UX control over an
existing polling loop.

## Out of scope

- Push/streaming updates (SSE/WebSocket) to replace polling entirely —
  unchanged long-term item already tracked in the architecture blueprint.
- Per-project or per-account persistence of the setting (localStorage is
  browser-scoped only).
- Any change to what polling fetches or how progress is parsed — only
  whether/how often the existing fetch runs.
