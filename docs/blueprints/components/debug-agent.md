# Component Blueprint: `packages/debug-agent`

## Purpose

Investigates and fixes issues in an already-built, previously-working
generated project — a user-reported problem via `/debug <description>`,
or a general health check via `/debug` with no description. Does *not*
duplicate the Codegen Agent's tool-calling loop: reuses
`runCodegenLoop`/`createFileTools`/`createDockerRunner` from
`@app-builder/codegen-agent` directly, supplying its own system prompt
and running two scoped passes (backend, then frontend) instead. See
[debug-agent.md](../../designs/debug-agent.md).

## Key files

- [`src/toolDefinitions.ts`](../../../packages/debug-agent/src/toolDefinitions.ts) —
  `buildDebugToolDefinitions(side)`: the same five tool *names* as
  codegen-agent's `TOOL_DEFINITIONS`, but described as relative to the
  *project root*, not just `backend/`/`frontend/` — needed so the model
  can reach `CLAUDE.md`/`docs/backlog.md` for the logging step below.
  `executeTool()` in codegen-agent doesn't care about descriptions, only
  tool names, so no changes were needed there for dispatch — only an
  additive `toolDefinitions?` override on `runCodegenLoop`'s `RunOptions`
  (defaulting to the stock `TOOL_DEFINITIONS`) so this override could be
  passed through at all.
- [`src/promptContext.ts`](../../../packages/debug-agent/src/promptContext.ts) —
  `buildDebugSystemPrompt(side)`: investigate before changing anything,
  fix narrowly, and — for every issue actually fixed — read the
  project's own `CLAUDE.md` and log a row to its `docs/backlog.md` Bugs
  table per that project's own Bug workflow.
- [`src/context.ts`](../../../packages/debug-agent/src/context.ts) —
  `assembleInitialContext()`: runs both sides' verification commands
  (`bundle exec rspec`/`npx jest`) and, if the project is currently
  running live, fetches each component's recent logs
  (`docker compose logs --tail=200 <service>` via `@app-builder/run-agent`'s
  `runDockerCompose`) — a one-shot snapshot fed into the initial context,
  not an interactive tool the model can call mid-loop.
- [`src/agent.ts`](../../../packages/debug-agent/src/agent.ts) —
  `runDebugAgent()`: assembles context, runs the backend pass then the
  frontend pass (fileTools rooted at the whole project, not per-side),
  re-verifies both sides for real, and skips teardown if the project is
  currently live (same rule `runCodegenPhase` follows for the Run Agent).
  Injectable deps (`RunDebugAgentDeps`) mirror `@app-builder/run-agent`'s
  `createRunAgent(deps)` pattern for testability.

## `fixed` means *both* sides pass, not just what was touched

`runDebugAgent()`'s final verification always re-runs both `bundle exec
rspec` and `npx jest`, regardless of which pass(es) changed anything —
`fixed: true` requires both to pass. This is deliberate: a reported issue
can be genuinely fixed while the project still has an unrelated,
pre-existing failure elsewhere, and `fixed: false` in that case is an
honest signal, not a bug in the Debug Agent. See the live verification
below for a real example of exactly this.

## Live verification (2026-09-03)

Introduced a real backend bug into an already-built, previously-passing
generated project (dropped `:done` from a controller's permitted
params, breaking 2 of 21 rspec examples). Ran the real `runDebugAgent`
against it with the description *"Toggling a task's done status from the
app doesn't actually save — it always comes back false."* Result:
correctly diagnosed the root cause, fixed it, re-verified (21/21 backend
examples passing), and logged two well-formed rows into the project's own
`docs/backlog.md` Bugs table (`fixed`, design-doc column correctly left
blank for a small fix) — a two-file footprint (the controller + the
backlog), nothing else touched. The frontend pass correctly recognized
the reported issue wasn't on its side and made no changes. Overall
`fixed: false` because the project's frontend suite had a pre-existing,
unrelated failure predating this work — exactly the honest signal
described above, not a failure to fix the reported bug. Full details:
[debug-agent.md](../../designs/debug-agent.md)'s Verification status.

## Known limitations

- No review/approval gate before fixing (unlike `/build`'s Intake →
  review → `/proceed`) — investigation and fixing are one fire-and-forget
  operation.
- No automatic triggering from Run Agent health-check failures — chat
  command only.
- The backend/frontend pass split means a single run can't atomically
  coordinate a fix that must touch both sides in lockstep — each pass
  only sees the other side's *test results*, not its live code changes
  from earlier in the same run.
- A small/free-tier model may not converge cleanly within a pass (keeps
  exploring past the point a fix is already verified working) — bounded
  safely by the iteration cap, just wasteful; not a correctness issue,
  since `runDebugAgent` never trusts a pass's own "done" claim either.

## Tests

[`test/`](../../../packages/debug-agent/test) — `toolDefinitions.test.ts`
(tool names, project-root wording, per-side `run_command`/search scoping),
`context.test.ts` (description vs. general-sweep framing, both sides'
test summaries, live-log fetching mocked via `@app-builder/run-agent`),
and `agent.test.ts` (pass ordering, system prompts per pass, `fixed`
combining logic, teardown skipped when live — all via injected fakes, no
real Docker/LLM). The real two-pass flow, tool execution, and backlog
logging are verified live — see above.
