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
| GET | `/api/projects/:id/progress` | live LLM call status for the footer display (`{ progress: ProgressSnapshot \| null }`); 404 if the project doesn't exist — see Token usage reporting below |
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
  frontend," the Codegen Agent's own narration). Token usage is reported
  separately — see Token usage reporting below — not mixed into chat.
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

### `/build` against an already-built project (feature #18)

`/build`'s handler reads the target project's own
`docs/blueprints/features.md` before calling Intake
(`readExistingProjectContext()`) — still the scaffold's stub text means
fresh (`existingContext: undefined`, today's behavior above); anything
else means incremental (`architecture.md`/`backlog.md` are read too and
handed to Intake, which switches to `buildIncrementalSystemPrompt()`).
This is reality-based, not a stored pass/fail flag, specifically so a
follow-up after a failed build still builds on whatever was genuinely
attempted. `pendingSpecs` (keyed by `projectId`) now holds
`{ spec, featureSlug, isIncremental }`, not a bare string — `featureSlug`
is derived from a `# <Feature Title>` line Intake is instructed to lead
its reply with (`deriveFeatureSlug()`/`slugify()`), and both fields flow
through `/proceed` into `defaultRunCodegenPhase`.

Every build — fresh or incremental, passing or not — now also leaves a
real record via two new tools (`read_project_doc`/`write_project_doc`,
scoped to a fixed allowlist: `features.md`, `architecture.md`,
`backlog.md`, `CHANGELOG.md`, `docs/designs/<slug>.md`) that
`defaultRunCodegenPhase` supplies to both the backend and frontend
Codegen phases, alongside a mandatory "before you finish" instruction in
their system prompts (bug #16). Since that instruction only fires when
the model reaches a *natural* stop, `runFeatureWorkflowEpilogue()` is a
safety net: whenever the final authoritative test run doesn't pass
(model never converged, or converged but was simply wrong), a bounded
follow-up `runCodegenLoop` call — restricted to *only* the project-doc
tools, told not to touch application code — writes the real outcome
instead of leaving no record at all. See
[intake-iteration.md](../../designs/intake-iteration.md).

### `/build` also sees prior chat, not just its own description (bug #17)

Before calling Intake, `/build`'s handler fetches `chatStore.get(projectId)`
and passes it through `filterHistoryForIntake()`, which drops only the
noisy interim tags (`[build]`/`[debug]` narration, the `"[run] Starting
your app..."` pending line — `isNoisyProgressMessage()`) and keeps
everything else: every terminal outcome tag (`[build:done]`,
`[build:failed]`, `[build:question]`, `[build:review]`, `[run:live]`,
`[run:failed]`, `[debug:done]`, `[debug:failed]`, `[stop:done]`), all
user messages (including past `/build`/`/proceed`/`/debug` commands
verbatim), and plain untagged assistant chat. `RunIntakePhase.history`
carries this through to `runIntake`, which inserts it between the system
prompt and the current description — the same message shape ordinary
chat already uses. The Codegen Agent deliberately does **not** also
receive raw chat — it continues to rely on Intake's distilled spec, per
the existing separation of concerns (Intake: language comprehension;
Codegen: spec execution). Live-verified: a preference stated in a plain
chat message before `/build` (a field-naming convention) showed up
correctly in Intake's proposed plan.

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

### Token usage reporting

A small in-memory `progressByProject: Map<string, ProgressSnapshot>` in
`createApp`'s closure (same lifetime as `buildingProjects`) tracks, per
project, `{ agentLabel, totalSentTokens, totalReceivedTokens,
callStartedAt }`. Each of `defaultRunIntakePhase`, `defaultRunCodegenPhase`,
and `defaultRunDebugPhase` wraps the `llmClient` it receives with
[`llm-client`](./llm-client.md)'s `withUsageReporting(client, { onCallStart,
onUsage })`; the route handler wires those hooks to
`markCallStarted`/`recordUsage` closures over `projectId`, and calls
`resetProgress(projectId, "<Agent Name>")` at the start of each phase
invocation (so totals are per phase, not cumulative across a whole
`/build`). The label lives at the orchestrator call site — the agent
packages themselves are unmodified. `GET /api/projects/:id/progress`
exposes the current snapshot for the web UI's footer, polled on the same
cadence as chat messages. See
[token-usage-reporting.md](../../designs/token-usage-reporting.md)'s
Amendment section.

### Agent-event → chat progress relay

`defaultRunCodegenPhase` and `defaultRunDebugPhase` each build a
`forward(event: AgentEvent)` closure passed as `onEvent` into
`runCodegenAgent`/`runCodegenLoop`/`runDebugAgent`. It turns three kinds
of event into an `onProgress(...)` chat line:

- `assistant_message` with non-null `content` — the model's own
  narration, posted as-is.
- `tool_call` — a one-line summary via `formatToolCall()` (e.g. `"→
  write_file: app/models/note.rb"`), never the tool's result. Without
  this, the chat log goes quiet for however long the model keeps calling
  tools without narrating in plain text — bug #14.
- `empty_turn` — a turn with neither text nor a tool call — via
  `formatEmptyTurn()`, naming the real `finishReason` (`"ran out of
  token budget"` when it's `"length"`) — bug #15. The real fix for *why*
  these happen is [codegen-agent](./codegen-agent.md)'s `maxTokens`
  ceiling (raised to 8192, matching Intake's); this is the fallback for
  whenever one still slips through.

Both `"→ "`-prefixed kinds render as compact metadata in the web UI, not
full chat bubbles — see [web blueprint](./web.md)'s Chat rendering
section (bug #16).

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
  updates, chat history, `/build` (ack + interim + terminal messages, the
  concurrency guard, empty-description rejection, ordinary chat
  unaffected), `defaultRunIntakePhase`'s usage reporting directly,
  `GET /api/projects/:id/progress` (null/404, cumulative accumulation
  across calls, a real non-null `callStartedAt` while a fake call is
  in-flight, reset-to-zero on a new phase), `readExistingProjectContext`/
  `slugify`/`deriveFeatureSlug` against real temp directories,
  `isNoisyProgressMessage`/`filterHistoryForIntake` (interim tags
  dropped, every terminal tag and all plain conversation kept), and
  route-level tests confirming `existingContext`/`isIncremental`/
  `featureSlug`/filtered `history` are threaded correctly from `/build`
  through to Intake and on to `/proceed`. Runs with no Postgres or
  Docker required — the real
  `defaultRunBuild`/`defaultRunCodegenPhase`/`defaultRunDebugPhase` flow
  (the live token-usage footer, and feature #18's incremental-mode +
  epilogue behavior) was verified manually through the actual browser UI
  and direct API calls, not in this suite; see the relevant design
  records' Outcome/Verification sections.
- [`test/scaffold.test.ts`](../../../packages/orchestrator/test/scaffold.test.ts) —
  exercises the real `fs.cp` copy against temp directories: copies the
  tree, creates `PROJECT_FILES_DIR` if missing, throws instead of
  overwriting an existing destination.
- The Postgres-backed stores (`postgresProjectStore.ts`/
  `postgresChatStore.ts`) are verified manually against a real local
  Postgres (`docker compose up -d` in this directory), not in the
  automated suite — see
  [`chat-history-persistence.md`](../../designs/chat-history-persistence.md).
