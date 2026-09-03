# Design: Frontend Generation (Screens + Human Review Gate)

- **Backlog item**: [`docs/backlog.md`](../backlog.md) — # 8 (Phase 3 extension)
- **Status**: building — implementation complete, live verification in
  progress and paused mid-way (see Verification status below)

## Verification status (2026-09-02 – 2026-09-03)

**Done, verified for real:**

- The regenerated `stack-spec/template/frontend/` (real Expo TypeScript
  app, React Navigation/Zustand/React Native Paper/Jest-RNTL actually
  installed, real `package-lock.json`) — `npm install`, `npx jest`, and
  `npx tsc --noEmit` all pass, both directly in a matching `node:20-slim`
  container and through the actual `docker compose run --rm frontend`
  path the Codegen Agent will use.
- All unit tests across the monorepo and a full typecheck — the Intake
  Agent's `## Screens` section, the orchestrator's `/build`→review and
  `/proceed`→build split (including the concurrency guard and
  pending-spec replacement), `runCodegenAgent`'s configurable
  `verifyCommand`, and `defaultFrontendMaxIterations`.
- A live `/build` → review → `/proceed` run against a real project
  (`FrontendGenTest`, then a fresh `FrontendGenFresh`): the backend phase
  passed cleanly (21 examples, 0 failures) and the frontend phase made
  real, substantive progress across several attempts — a working API
  client, Zustand store, two screens, navigation, and three kinds of
  tests, reaching 18 of 24 tests passing before running out of iteration
  budget on the freshest attempt.
- Several real bugs found during this live verification and fixed —
  logged retroactively in [`docs/backlog.md`](../backlog.md) per the
  mandatory bug workflow (should have been logged *before* fixing; noted
  here as a process gap, not repeated going forward):
  - Bug #1 (wire-agents-into-chat regression): the `/build` handler's
    newly-*awaited* Intake call had no error handling — an upstream LLM
    error crashed the *entire* orchestrator process instead of failing
    just that one request. Fixed with `try`/`catch` returning `502
    llm_error`; covered by a regression test confirming the server keeps
    serving requests afterward.
  - Vitest (run from `packages/orchestrator`) started picking up
    scaffolded projects' own Jest/RNTL test files under
    `generated-projects/` and failing trying to transform them — fixed
    with a `vitest.config.ts` exclude.
  - **[Bug #3](../backlog.md)**: the backend template's generated
    `spec/rails_helper.rb` ships with the `spec/support/**/*.rb` require
    commented out (RSpec's own generator default) — every run had to
    rediscover this from scratch before it could start real work. Fixed
    by uncommenting it in the template.
  - **[Bug #4](../backlog.md)**: the frontend phase's final verification
    always reported a generic `"npx jest exited 1"` instead of real
    pass/fail counts, two compounding causes — Jest colorizes its
    summary (`CI=true` alone didn't suppress it, `FORCE_COLOR=0` did),
    and separately `runCodegenAgent`'s summary regex only ever searched
    `stdout`, but Jest's own summary reporter writes to `stderr`. Fixed
    with `FORCE_COLOR=0` on the frontend service and searching
    stdout+stderr combined.
  - **[Feature #9](../backlog.md)**: added a must-pass vs. nice-to-have
    test tiering (requested directly by the user mid-verification,
    watching the model repeatedly fail on a React Native Paper
    `TextInput` accessibility-label query mismatch) — `stack-spec/
    guidelines/testing.md` and the frontend system prompt now tell the
    model it may `it.skip()` a purely accessibility-query failure after
    one real fix attempt, never a must-pass one.

**Still open:**

- **[Bug #5](../backlog.md)**, reported not yet fixed: the frontend
  template never installs `react-dom`/`react-native-web`, so `expo start
  --web` fails immediately — the web target (one of the three locked
  platforms) can't actually be manually run/viewed yet even though the
  automated `npx jest` verification doesn't need it. Found while trying
  to start a live preview for manual inspection; fix approach to be
  agreed before implementing.
- A full clean end-to-end run (backend + frontend both passing in one
  `/proceed`) hasn't been observed yet — closest so far is 18/24 frontend
  tests passing before the iteration cap. Paused at the user's request to
  inspect the current artifact directly rather than keep retrying live.

## Summary

Extends `/build` end-to-end into the frontend: the Intake Agent now also
designs the screens a product needs (objective + behavior, its own
judgment from the free-text description — not a fixed one-screen-per-
resource template), and the Codegen Agent gains a second, chained phase
that implements exactly those screens as real Expo/React Native code,
wired to the backend API it already generates, verified by `npx jest`
inside Docker. Between the two, `/build` now stops and shows the
proposed plan in chat for a human to actually read before anything is
built — a new `/proceed` command confirms it.

This touches all three already-shipped pieces (Intake Agent, Codegen
Agent, the orchestrator's `/build` wiring) and needs the same "regenerate
the template for real" treatment `stack-spec/template/backend/` got in
Milestone 1 — `stack-spec/template/frontend/` is still a bare skeleton
today (placeholder `package.json` versions, no lockfile, no Jest/babel/
tsconfig, no Dockerfile). Real risk, same category as every prior
milestone: needs a real end-to-end run through the browser before being
called done, not just unit tests.

## Feature-set impact

- A `/build <description>` no longer goes straight to code generation.
  It now runs only the Intake Agent, then posts the **proposed plan** —
  every resource (fields, associations) and every screen (name,
  objective, what it shows/how it behaves) — into chat, tagged so it's
  clearly a plan awaiting a decision, not a result.
- **`/proceed`** builds that exact plan: backend first (unchanged
  behavior), then — once it passes — the frontend: real screens using
  Expo/React Native + Zustand + React Native Paper + React Navigation
  (the locked stack), wired to the backend endpoints, verified by a real
  `npx jest` run inside Docker.
- Sending a new `/build <description>` while a plan is pending review
  simply replaces it — no separate cancel command.
- If Intake still can't produce a plan (missing info, unresolvable
  relationships), the reply is its clarifying question, same as before —
  unaffected by this change.

## Architecture impact

Five things change, none of them new components:

1. **`packages/intake-agent`** — the markdown brief format grows a
   `## Screens` section (see shape below). Prompt-only change — `runIntake`
   itself needs no code change, since it still just returns whatever text
   comes back.
2. **`packages/orchestrator`** — `/build` splits into two phases instead
   of one fire-and-forget pipeline: an *awaited* Intake-only call (fast —
   a single LLM call, no reason to make the user wait on a spinner for a
   fire-and-forget promise), and a new `/proceed` command that pops a
   stored pending spec and runs the (now two-phase) Codegen pipeline
   fire-and-forget, same as `/build` used to.
3. **`packages/codegen-agent`** — `runCodegenAgent`'s final verification
   command becomes a parameter (default `bundle exec rspec`, unchanged
   for backend) instead of hardcoded, so the same function serves a
   frontend phase verified by `npx jest` instead. A new
   `buildFrontendSystemPrompt()` sits next to the existing
   `buildSystemPrompt()` (renamed in spirit to "backend" but keeping its
   name for compatibility) with frontend-specific required-sequence
   instructions. No changes to `runCodegenLoop`/tools/dockerExec — they
   were already generic over which root/service they point at.
4. **`stack-spec/template/frontend/`** — regenerated for real: a working
   Expo app (real dependency versions + lockfile, Jest configured with
   `jest-expo`, TypeScript configured, React Navigation/Zustand/React
   Native Paper actually installed) plus a `Dockerfile` and a `frontend`
   service in `docker-compose.yml` (with a named `frontend_node_modules`
   volume — same ephemeral-container lesson from Milestone 1: installed
   packages vanish between `docker compose run --rm` invocations without
   one).
5. **`packages/web`** — the polling trigger changes from "did the user
   type `/build`" to "does the reply's tag indicate something is actually
   running" (`/^\[build\]/`, no colon) — works for `/proceed` without
   special-casing each command name. `BUILD_TERMINAL_PATTERN` gains
   `review` as a fourth terminal state (nothing is running yet — no
   reason to poll — until `/proceed`).

## Components affected

- [`packages/intake-agent`](../../packages/intake-agent) — `promptContext.ts`
- [`packages/codegen-agent`](../../packages/codegen-agent) — `agent.ts`
  (`runCodegenAgent`'s verify-command parameter), `promptContext.ts`
  (`buildFrontendSystemPrompt`)
- [`packages/orchestrator`](../../packages/orchestrator) — `app.ts`
  (two-phase `/build`, new `/proceed`, `pendingSpecs` map, updated
  `SYSTEM_PROMPT`)
- [`packages/web`](../../packages/web) — `App.tsx` (polling trigger,
  terminal pattern, subtitle copy)
- [`stack-spec/template/frontend/`](../../stack-spec/template/frontend) —
  real Expo scaffold; new `docker-compose.yml` `frontend` service

## Design

### Intake Agent: `## Screens` markdown shape

Added after the existing per-resource blocks, one sub-heading per screen
— not required to map 1:1 to a single resource:

```
## Screens
### List Overview
Objective: Let the user see all their todo lists and open one.
Shows: a scrollable list of List names; tapping one navigates to Item Overview.

### Item Overview
Objective: Manage the items within a single list.
Shows: a checklist of Items (title + done toggle) for the selected list, a
button to add a new item, tapping an item opens Item Edit.

### Item Edit
Objective: Create or edit one item's title and done status.
Shows: a form (title text field, done toggle) with save/cancel.
```

The system prompt instructs: design the smallest set of screens that
actually cover the described product's workflows — not one screen per
CRUD action reflexively, and not more than the description implies.
Unchanged: the `QUESTION:` convention still fires for missing/
unresolvable resource-level info; an Intake Agent that can identify the
resources can essentially always propose *some* reasonable screens, so
this isn't treated as a new source of ambiguity.

### Orchestrator: two-phase `/build`, review gate, `/proceed`

```ts
export type RunIntakePhase = (params: {
  description: string;
  llmClient: LLMClient;
}) => Promise<{ kind: "question" | "spec"; content: string }>;

export type RunCodegenPhase = (params: {
  workspacePath: string;
  buildSpec: string;
  llmClient: LLMClient;
  onProgress: (content: string) => void;
}) => Promise<{ kind: "done" | "failed"; content: string }>;
```

`pendingSpecs: Map<projectId, string>` sits next to the existing
`buildingProjects: Set<projectId>` in `createApp`'s closure.

**`/build <description>`** (guarded by `buildingProjects`, same as
today — no new Intake call while a build is actually running):

```
result = await runIntakePhase({ description, llmClient })   // awaited — one fast LLM call
if result.kind === "question":
  append+reply "[build:question] " + result.content
else:
  pendingSpecs.set(projectId, result.content)
  append+reply "[build:review] Proposed plan — reply /proceed to build it, " +
               "or send a new /build <description> to try again:\n\n" + result.content
```

No fire-and-forget here — this always resolves quickly, so there's no
"looks stuck" problem to solve for this phase.

**`/proceed`** (new):

```
if buildingProjects.has(projectId): reply "[build] A build is already running..." (unchanged guard)
if !pendingSpecs.has(projectId): reply "Nothing is pending review for this project — send /build <description> first." (no [build] tag — nothing will run, so the client must not start polling)
else:
  spec = pendingSpecs.get(projectId); pendingSpecs.delete(projectId)
  append+reply "[build] Got it — starting the build. This can take several minutes."
  buildingProjects.add(projectId)
  runCodegenPhase({ workspacePath, buildSpec: spec, llmClient, onProgress })
    .then(outcome => append `[build:${outcome.kind}] ${outcome.content}`)
    .catch(error => append `[build:failed] Unexpected error: ${error.message}`)
    .finally(() => buildingProjects.delete(projectId))
```

Sending a new `/build` while a spec is pending just overwrites
`pendingSpecs` — no special-casing needed, since `/build`'s handler
doesn't consult `pendingSpecs` at all.

`SYSTEM_PROMPT` (ordinary chat passthrough) is updated to describe the
full `/build` → review → `/proceed` flow, not just `/build`.

### `defaultRunCodegenPhase`: backend, then frontend, one teardown

```ts
const backendDocker = createDockerRunner(workspacePath, "rails");
const frontendDocker = createDockerRunner(workspacePath, "frontend");
try {
  const backendResult = await runCodegenAgent({
    llmClient, systemPrompt: await buildCodegenSystemPrompt(), buildSpec,
    fileTools: createFileTools(path.join(workspacePath, "backend")),
    dockerRunner: backendDocker, onEvent: forward(onProgress),
  }); // verifyCommand defaults to "bundle exec rspec"
  if (!backendResult.testsPassed) return { kind: "failed", content: `Backend: ${backendResult.verifySummary}` };

  onProgress(`Backend complete — ${backendResult.verifySummary}. Starting the frontend...`);

  const frontendResult = await runCodegenAgent({
    llmClient, systemPrompt: await buildFrontendSystemPrompt(), buildSpec,
    fileTools: createFileTools(path.join(workspacePath, "frontend")),
    dockerRunner: frontendDocker, verifyCommand: "npx jest", onEvent: forward(onProgress),
  });
  return frontendResult.testsPassed
    ? { kind: "done", content: `Backend: ${backendResult.verifySummary}; Frontend: ${frontendResult.verifySummary}` }
    : { kind: "failed", content: `Frontend: ${frontendResult.verifySummary}` };
} catch (error) {
  return { kind: "failed", content: `Build failed: ${error.message}` };
} finally {
  await backendDocker.down(); // docker compose down tears down the whole stack — one call covers both services
}
```

### `runCodegenAgent`: verify command becomes a parameter

```ts
export interface RunOptions {
  // ...unchanged fields...
  /** Final, authoritative check — never the model's own "done" claim alone. Default: "bundle exec rspec". */
  verifyCommand?: string;
}

export async function runCodegenAgent(options: RunOptions): Promise<RunCodegenAgentResult> {
  const verifyCommand = options.verifyCommand ?? "bundle exec rspec";
  const loopResult = await runCodegenLoop(options);
  const verification = await options.dockerRunner.run(verifyCommand);
  const summary =
    verification.stdout.match(/^\d+ examples?, \d+ failures?.*$/m)?.[0] ??
    verification.stdout.match(/^Tests:.*$/m)?.[0] ??
    `${verifyCommand} exited ${verification.exitCode}`;
  return {
    converged: loopResult.converged,
    iterations: loopResult.iterations,
    testsPassed: verification.exitCode === 0,
    verifySummary: summary,
    verifyOutput: verification.stdout,
  };
}
```

`rspecSummary`/`rspecOutput` are renamed to `verifySummary`/`verifyOutput`
— a disclosed breaking rename, same treatment as the earlier `--spec`
JSON→text change; every call site (CLI, orchestrator, tests) updates
together in this same change.

### Frontend required sequence (new `buildFrontendSystemPrompt`)

1. `npm install` (once).
2. Read the build spec's `## Screens` section; implement exactly those
   screens under `src/screens/`, per `frontend-architecture.md`
   (Zustand store per bounded domain, React Native Paper components, a
   single `src/api/client.ts` — no ad hoc fetch calls in screens).
3. Wire navigation (React Navigation) matching how the screens connect
   per their described behavior.
4. Write a render test per screen and a unit test per store
   (`testing.md`), with the API client mocked — no real network calls.
5. Run `npx tsc --noEmit` and fix type errors before claiming done — the
   model's own hygiene step, not the authoritative gate.
6. Run `npx jest` yourself; only claim done once it's clean — the
   orchestrator/CLI re-runs it afterward regardless, as the real gate.

### `stack-spec/template/frontend/`: real Expo scaffold

Same approach as the backend's Milestone 1: generate for real (a real
Expo project — TypeScript template — inside a Node container matching
the locked runtime), then layer in React Navigation, Zustand, React
Native Paper, Jest (`jest-expo` preset) + React Native Testing Library
via real `npm install`, commit the resulting `package-lock.json` for
deterministic installs (same rationale as `Gemfile.lock`), add a
`Dockerfile` (`FROM node:<LTS>-slim`, bind-mount pattern matching
`backend/Dockerfile`), and add the `frontend` service + a
`frontend_node_modules` named volume to `docker-compose.yml`. Whatever
real setup issues come up doing this become part of this doc's Outcome
section, the same way Milestone 1's five real runs did for the backend.

### Web UI changes

```ts
const BUILD_TERMINAL_PATTERN = /^\[build:(done|failed|question|review)\]/;
// ...
if (body.reply && /^\[build\]/.test(body.reply)) {
  setBuildingProjects((prev) => ({ ...prev, [selectedProjectId]: true }));
}
```

Dropping the `message.startsWith("/build")` check in favor of reacting to
the reply's own tag means `/proceed` needs no special-casing to also
trigger polling.

## Verification plan

Same discipline as every prior milestone:

1. Unit tests: Intake Agent's `promptContext` (screens shape present),
   orchestrator's `/build`+`/proceed` split (fake `RunIntakePhase`/
   `RunCodegenPhase` — plan review, `/proceed` with/without a pending
   spec, replacing a pending spec with a new `/build`), Codegen Agent's
   `runCodegenAgent` with a non-default `verifyCommand`. No real Docker/
   GLM in this layer.
2. **Real end-to-end run through the actual browser**: a multi-resource
   description (reusing the Todo List case already proven on the
   backend), through `/build` → review the posted plan → `/proceed` →
   watch backend progress → watch frontend progress → confirm a real
   `npx jest` pass, the same way `wire-agents-into-chat.md`'s Outcome was
   verified live, not just asserted.

## Out of scope (this milestone)

- No standalone CLI flag for the frontend phase yet (`codegen-agent
  --target frontend` or similar) — reachable only through
  `/build`/`/proceed` for now; the underlying functions are exported and
  usable, just not wired into `cli.ts`'s argument parsing.
- No visual/screenshot verification, no real device/simulator testing —
  `npx jest` (render tests + store unit tests) is the authoritative
  check, same spirit as `bundle exec rspec` for the backend: correctness
  of what's testable, not a visual judgment call.
- No iterative plan revision conversation — disagreeing with a proposed
  plan means sending a new `/build` with a fuller/different description,
  not a back-and-forth negotiation.
- Many-to-many associations, auth, MongoDB, Sidekiq — unchanged,
  still real Phase 1/2 backend work, untouched by this design.
