# Component Blueprint: `packages/codegen-agent`

## Purpose

The sandboxed LLM tool-calling loop that writes and *runs* real code
against an already-scaffolded project until it works. First proven on a
single CRUD resource (Milestone 1 — see
[design record](../../designs/codegen-agent-milestone-1.md)), then
extended to an arbitrary number of related resources plus associations
built in dependency order (see
[multi-resource-support.md](../../designs/multi-resource-support.md)):
backend only, no auth/Mongo/Sidekiq/frontend yet. Usable two ways: the
standalone CLI, or as a library — `packages/orchestrator`'s `/build` chat
flow calls `runCodegenAgent()` directly (see
[wire-agents-into-chat.md](../../designs/wire-agents-into-chat.md)).

## Key files

- [`src/cli.ts`](../../../packages/codegen-agent/src/cli.ts) — entrypoint;
  wires everything together, prints progress, runs the mandatory final
  `bundle exec rspec` check, tears down containers when done
- [`src/agent.ts`](../../../packages/codegen-agent/src/agent.ts) — the
  tool-calling loop (`runCodegenLoop`): calls the model, executes tool
  calls, feeds results back, until the model responds with non-empty
  plain text or the iteration cap is hit. `defaultMaxIterations(buildSpec)`
  scales the cap with how many `## Resource` headings the spec text
  contains (`max(25, resourceCount * 20)`) — a cheap heading count, not a
  real parse of fields/associations. `runCodegenAgent()` wraps the loop
  with the final `bundle exec rspec` check and returns a plain result
  (`testsPassed`, `rspecSummary`, `rspecOutput`) — the shared entrypoint
  both `cli.ts` and the orchestrator use; teardown (`dockerRunner.down()`)
  stays the caller's job either way
- [`src/tools.ts`](../../../packages/codegen-agent/src/tools.ts) —
  `read_file`/`write_file`/`list_dir`/`list_files`/`search_files` (all
  path-scoped, host-side `fs` ops against the bind-mounted `backend/`)
  and the `run_command` tool definition. Also `read_project_doc`/
  `write_project_doc` (`createProjectDocsTools`) — a fixed allowlist
  (`docs/blueprints/features.md`, `architecture.md`, `docs/backlog.md`,
  `CHANGELOG.md`, `docs/designs/<slug>.md`), not a general project-root
  sandbox, appended to the tool schema only when a caller supplies
  `projectDocsTools` — see feature #18/bug #16.
- [`src/dockerExec.ts`](../../../packages/codegen-agent/src/dockerExec.ts) —
  runs commands via `docker compose run --rm rails <cmd>`; `down()` tears
  down dependency containers after a run
- [`src/promptContext.ts`](../../../packages/codegen-agent/src/promptContext.ts) —
  builds the system prompt from `stack-spec/versions.yaml` +
  `guidelines/*.md`; `loadBuildSpec` reads the `--spec` file as plain
  text, no parsing — it can be hand-written or produced by the
  [Intake Agent](./intake-agent.md)

## Execution model

Backend commands run inside Docker (`docker compose run --rm rails
<command>`), never on the host — sidesteps this machine's Ruby version
entirely and matches the locked stack exactly. `stack-spec/template/`
provides a real `rails new --api` + `rspec:install` skeleton (not a bare
scaffold) with `config.generators.orm = :active_record` set explicitly,
so `mysql2`/build-essential native deps and Rails/rspec boilerplate don't
have to be regenerated — or rediscovered — on every run. See
[stack-spec blueprint](./stack-spec.md) for what's baked into the
template versus left for the agent.

The model's own "I'm done" is never trusted: the CLI always runs
`bundle exec rspec` itself as the final, authoritative check, regardless
of whether the loop converged or hit its iteration cap.

`AgentEvent` (`assistant_message`, `tool_call`, `tool_result`,
`empty_turn`) is how a caller observes the loop as it runs — the
orchestrator's `forward()` turns these into chat progress. `maxTokens`
per call is `8192` (bug #15) — matches [Intake Agent](./intake-agent.md)'s
ceiling, since the same model spends tokens on hidden reasoning before
visible output; too tight a budget risks a turn coming back with neither
text nor a tool call (an "empty turn," `AgentEvent`'s `empty_turn`
variant), which the loop nudges past rather than treating as done.

`RunOptions.projectDocsTools` + a `FeatureWorkflowContext` (`featureSlug`,
`isIncremental`) passed to `buildSystemPrompt`/`buildFrontendSystemPrompt`
add a mandatory final step to both prompts: before finishing (success or
not), follow the project's own Feature workflow — write/continue a real
`docs/designs/<slug>.md`, log/update a `docs/backlog.md` row, update
`docs/blueprints/features.md`, add a `CHANGELOG.md` entry. Both params
are optional and only supplied by the orchestrator's `/build` flow — the
standalone CLI omits them, so the model is never told about tools it
doesn't actually have. Incremental mode (`isIncremental: true`) also adds
an explicit "this app already has real code — don't break/rename/
duplicate it" warning. See feature #18/bug #16 —
[intake-iteration.md](../../designs/intake-iteration.md).

`FeatureWorkflowContext` also carries an optional `inProgressDesignDocs:
{ slug, content }[]` (bug #19) — design docs for any of this project's
backlog rows not yet `done`/`fixed`, supplied by the orchestrator. Unlike
the final-step instruction above (which only tells the model to *read*
the matching doc right before finishing), this content is included
directly in the *initial* system prompt via
`buildInProgressDesignDocsSection()`, telling the model to trust the
Outcome sections as authoritative for what's already verified passing
and skip re-exploring/re-verifying it — cutting the from-scratch
re-discovery every phase invocation otherwise does. See
[build-context-and-resume.md](../../designs/build-context-and-resume.md).

`buildInProgressDesignDocsSection()` takes a `side: "backend" | "frontend"`
param (bug #20) — a regression caught live: the model would correctly
conclude "my side is done, remaining work is on the other side" but then
loop trying to explore/verify that other side anyway, unable to reach it
(each phase's `fileTools` is rooted at just `backend/` or `frontend/`).
The section now explicitly says which directory the model's tools are
scoped to, that the other side is unreachable from here, and to do one
quick verification then stop immediately with a plain-text summary if
all that's left is on the other side.

`buildFeatureWorkflowInstructions()` also takes an optional `side`
param (bug #21) — a second regression caught on the very next live run:
telling a phase "you can't reach the other side" (bug #20) was true for
*that phase*, but when it got paraphrased into a persisted doc
(`docs/backlog.md`) it lost that scoping and read as a permanent claim
about "the Codegen Agent," which a later run of the *other* phase then
echoed back even though it could plainly reach that work. The
instruction now tells the model to phrase other-side work as needing
that side's *phase* to complete it (e.g. "needs a frontend-phase
build"), never as unreachable or out of scope. Threaded through both
`buildSystemPrompt("backend")`/`buildFrontendSystemPrompt("frontend")`
and the orchestrator's `runFeatureWorkflowEpilogue` (which now takes a
`side` param too, set from `defaultRunCodegenPhase`'s existing
`currentPhase` tracker).

### Planning stage (feature #22)

New `buildPlanningSystemPrompt()` and `PLANNING_TOOL_DEFINITIONS`
(`tools.ts`) — a bounded, read-only pass the orchestrator runs before
any code-writing phase on an incremental build, motivated by three
consecutive live GLM timeouts on the same feature: each one hit right
after 30+ tool calls of re-exploring the whole relevant directory,
before any code got written. `PLANNING_TOOL_DEFINITIONS` offers the same
five explore-tool names plus `read_project_doc`/`write_project_doc`,
deliberately missing `write_file`/`run_command` — the model is simply
never offered those two, so it structurally cannot write or run
application code during planning. Its system prompt asks it to decide
`Scope: backend-only | frontend-only | both` and write a concrete
file-level plan into the design doc's own `## Plan` section, reusing an
existing accurate plan rather than re-deriving one.

`buildInProgressDesignDocsSection()` also detects a `## Plan` heading in
any fed-in design doc and appends a hard, side-aware instruction: treat
it as the authoritative task list, do not call `list_files`/`list_dir`
broadly or read files it doesn't name, open exactly what it lists. This
is deliberately stronger than the existing "don't spend more than 2-3
tool calls exploring" line already in both system prompts — live
evidence (30+ exploration calls per run) showed that softer phrasing
alone wasn't enough once a phase decided broader context was warranted.

## CLI interface

```
codegen-agent --workspace <path-to-scaffolded-project> --spec <path-to-build-spec.md>
```

`--spec` is read as plain text — any format works as far as the code is
concerned, but a short markdown brief (resource name + a bulleted field
list) is what the [Intake Agent](./intake-agent.md) produces and what
this has been validated against.

## Known limitations

- No auth, MongoDB, Sidekiq, or frontend generation yet — all real Phase
  1 work still ahead.
- Associations limited to `belongs_to`/`has_many`/`has_one` — no
  many-to-many (`has_and_belongs_to_many`)/join-table support yet.
- No schema or validation on the spec file's content — a malformed or
  misleading brief surfaces the same way any other Codegen Agent mistake
  does, via a failing `bundle exec rspec` at the end.
- `bundle install` may rerun on each invocation depending on gem cache
  state; not yet optimized.
- The iteration-budget formula's constants (25 floor, +20/resource) are
  validated against 1-, 2-, and 3-resource specs only; unproven beyond
  that.

## Tests

[`test/`](../../../packages/codegen-agent/test) — unit tests for the loop
and `runCodegenAgent` (fake `LLMClient`/tools/docker runner —
pass/fail/rspec-summary-parsing cases, `empty_turn` firing with the real
`finishReason`, `projectDocsTools`/its two tool definitions being
appended/dispatched correctly and an explicit `toolDefinitions` override
still winning), `defaultMaxIterations`'s scaling formula, the file tools
(real temp dirs, path-traversal rejection, recursive listing, grep-style
search), `isProjectDocPath`/`createProjectDocsTools` (real temp dirs —
the fixed allowlist, `docs/designs/<slug>.md` accepted, everything else
rejected for both read and write), and prompt-context building (real
`stack-spec/` content, the Feature workflow instructions appearing only
when `featureWorkflow` is supplied, the incremental-mode warning
appearing only when `isIncremental: true`). No Postgres or Docker
required. The Docker-based execution and full end-to-end runs are
verified manually — see the design records (Milestone 1's
single-resource run, the multi-resource design's 2- and 3-resource runs,
wire-agents-into-chat.md's real run through the orchestrator/web UI, and
intake-iteration.md's incremental-mode + doc-writing-epilogue
verification) for what that took.
