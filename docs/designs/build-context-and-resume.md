# Design: Build/debug runs leave a resumable record instead of silently going stale

- **Backlog item**: [`docs/backlog.md`](../backlog.md) — Bug # 19
- **Status**: implemented — unit-tested (209 tests pass across all
  packages); live end-to-end verification against a real generated
  project (e.g. re-running `test_project`'s stalled audio-upload
  feature) not yet done — see Verification status below.

## Verification status

- All existing suites plus new tests pass: `parseInProgressDesignDocSlugs`
  (dedupes across Feature/Bugs tables, skips `done`/`fixed` rows, handles
  empty/link-less backlogs), `readExistingProjectContext` now also
  returning `inProgressDesignDocs` for a real fixture project,
  `buildIncrementalSystemPrompt`/`buildSystemPrompt`/
  `buildFrontendSystemPrompt` including (and omitting, when empty) the
  new section, and `runDebugAgent` running the doc-logging epilogue as a
  3rd `runCodegenLoop` call — both on a normal pass and after a thrown
  error (asserting the epilogue call's prompt carries the failure
  message, and that the original error still propagates to the caller).
  `npm run build` (full `tsc` across every package) is clean.
- Not yet live-verified: an actual `/build` run hitting a real GLM
  provider timeout to confirm the exception-path epilogue fires and
  writes real doc content in practice, and a real "continue" `/build`
  against a project with an in-progress design doc to confirm Intake
  produces a genuinely targeted delta rather than a full redescription.

## Summary

Today, a `/build`/`/proceed` run that ends in a thrown exception (a
provider timeout/rate-limit, not a test failure) skips the doc-writing
epilogue entirely — `docs/blueprints/features.md`/`backlog.md`/
`CHANGELOG.md` are left describing whatever state existed *before* that
attempt, even though real code may already be on disk. `/debug` has no
epilogue-equivalent at all. Separately, neither the Intake Agent's
incremental prompt nor the Codegen Agent's initial system prompt ever
reads the one place that already has the detailed "what's done / what's
left" record: the per-feature design doc's Outcome section, written by
the existing epilogue mechanism (feature #18). The result: a vague
"continue" request re-triggers a full Intake pass that either asks a
generic clarifying question or regenerates the entire original spec from
scratch, and every phase invocation re-explores the whole relevant
directory tree and reruns the full test suite before doing any real work
— because nothing tells it that's unnecessary.

Confirmed live in `test_project`'s own chat history: after two
consecutive `[build:failed] Build failed: GLM request timed out after
60000ms` attempts at an audio-upload feature, `features.md`/`backlog.md`
still describe the older "backend passing, frontend passing" state from
before that attempt — no record of what broke. Separately, a plain
"just continue building where it left off" produced a full re-read of
~16 backend files plus a full `bundle exec rspec` rerun before any
change was made, and a later `/build can you continue building`
regenerated the entire original Voice Notes spec (all fields, all three
screens) via Intake — even though `docs/designs/voice-notes.md`'s
Outcome section, at that exact moment, already spelled out precisely
what was done (backend: 57/57 passing, five specific endpoints listed as
tested) and what was left (two specific frontend wiring items) — Intake
just never saw it.

The fix reuses that existing design doc as the resume record — not a new
parallel artifact that would itself need to be kept in sync — and closes
the exception-path gap that leaves it stale in the first place.

## Feature-set impact

- Any ended `/build`/`/proceed` run — test failure *or* thrown exception
  (provider timeout, rate limit, etc.) — now leaves an honest doc trail.
  A provider hiccup no longer erases the record of what was actually
  attempted.
- `/debug` gets the same guarantee: an interrupted or failed debug run
  logs what it found/fixed/didn't into the project's own
  `docs/backlog.md`, not just a successful one.
- A follow-up `/build <anything, including a vague "continue">` against
  a project with unfinished work now has the specific in-progress design
  doc(s) in front of it — Intake's proposed plan targets exactly what's
  left (per the doc's own Outcome section) instead of re-describing the
  whole feature or asking a generic clarifying question.
- The Codegen Agent starts an incremental run already knowing what's
  verified passing and what isn't, from the design doc content handed to
  it up front — cutting down (not eliminating — it still verifies for
  real before finishing) the exploratory file-reading and test-rerunning
  it currently does from a standing start on every single phase
  invocation, fresh or incremental alike.

## Architecture impact

No new components, no new persisted artifact type — this reuses the
existing per-feature design doc (`docs/designs/<slug>.md`) as the
resume record on both the read and write side, closing the gap where it
was written but never read back into the next run's starting context.

- **`packages/orchestrator`**: `defaultRunCodegenPhase`'s exception
  handler now runs the same `runFeatureWorkflowEpilogue` the test-failure
  paths already use, instead of returning `kind: "failed"` directly.
  `readExistingProjectContext` additionally reads the design doc(s) for
  any backlog row not yet `done`, threading that content through to both
  `runIntakePhase` and `runCodegenPhase`.
- **`packages/debug-agent`**: `runDebugAgent` gains its own bounded,
  forced doc-logging follow-up pass (mirroring the codegen epilogue's
  shape, adapted to the Bug workflow), run regardless of whether the main
  two passes succeeded, failed, or threw.
- **`packages/intake-agent`**: `ExistingProjectContext` gains an
  `inProgressDesignDocs` field; `buildIncrementalSystemPrompt` includes
  it and instructs Intake to treat those Outcome sections as
  authoritative for what's done vs. left.
- **`packages/codegen-agent`**: `FeatureWorkflowContext` gains the same
  in-progress design-doc content, included in the *initial* system
  prompt (not just the final "before you finish" instruction, which
  already reads it but only at the end) with explicit permission to
  trust it and skip re-verifying what it already says is passing.

## Components affected

- `packages/orchestrator` — `src/app.ts`: `defaultRunCodegenPhase`'s
  catch block, `readExistingProjectContext`.
  [component blueprint](../blueprints/components/orchestrator.md)
- `packages/debug-agent` — `src/agent.ts`: `runDebugAgent`.
  [component blueprint](../blueprints/components/debug-agent.md)
- `packages/intake-agent` — `src/promptContext.ts`:
  `ExistingProjectContext`, `buildIncrementalSystemPrompt`.
  [component blueprint](../blueprints/components/intake-agent.md)
- `packages/codegen-agent` — `src/promptContext.ts`:
  `FeatureWorkflowContext`, `buildSystemPrompt`/`buildFrontendSystemPrompt`.
  [component blueprint](../blueprints/components/codegen-agent.md)

## Design

### 1. Epilogue runs on every non-success exit, not just test failures

`defaultRunCodegenPhase` (`app.ts:337-476`) currently has one `catch
(error)` at the end that returns `kind: "failed"` with no doc write —
the two test-failure branches above it already call
`runFeatureWorkflowEpilogue`. Track which phase is in flight and reuse
its tools in the catch:

```ts
let currentPhase: "backend" | "frontend" = "backend";
// ...
const backendResult = await runCodegenAgent({ ... });
currentPhase = "frontend"; // only reached once backend succeeds
// ...
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await runFeatureWorkflowEpilogue({
    llmClient: wrappedClient,
    buildSpec,
    outcomeSummary: `Build stopped by an unexpected error during the ${currentPhase} phase: ${message}`,
    fileTools: currentPhase === "backend" ? backendFileTools : frontendFileTools,
    dockerRunner: currentPhase === "backend" ? backendDocker : frontendDocker,
    projectDocsTools,
    featureWorkflow,
    onEvent: forward,
  });
  return { kind: "failed", content: `Build failed: ${message}` };
}
```

Best-effort, same as today's epilogue calls — a failure inside the
epilogue itself doesn't change the build's own reported outcome.

### 2. `/debug` gets an equivalent forced doc-logging pass

`runDebugAgent` (`packages/debug-agent/src/agent.ts:64-125`) already has
general file access reaching `docs/backlog.md` (its sandbox root is the
whole project), and its system prompt already asks it to log bugs there
— but nothing forces that if the model never reaches a natural stop
(exception, or exhausts its budget mid-fix). Add a bounded follow-up
pass, run in all cases (success, failure, and caught exception) via a
`finally`-adjacent step:

```ts
async function runDebugLoggingEpilogue(params: {
  llmClient: LLMClient;
  description: string | undefined;
  outcomeSummary: string;
  fileTools: FileTools;
  dockerRunner: DockerRunner;
  onEvent?: (event: AgentEvent) => void;
}): Promise<void> {
  try {
    await runCodegenLoop({
      llmClient: params.llmClient,
      systemPrompt: buildDebugLoggingPrompt(params.description, params.outcomeSummary),
      buildSpec: params.description ?? "(general health check)",
      fileTools: params.fileTools,
      dockerRunner: params.dockerRunner,
      maxIterations: 6, // one docs/backlog.md read + write pair, generous
      onEvent: params.onEvent,
    });
  } catch {
    // Best-effort — the debug run's own reported outcome is unaffected.
  }
}
```

Called once, after both passes (or from the catch path), with the same
"do NOT attempt more fixes, only log what genuinely happened" framing
the codegen epilogue uses. Uses the project-root `fileTools` `runDebugAgent`
already has — no new tool wiring needed.

### 3. In-progress design docs become part of both agents' starting context

`readExistingProjectContext` (`app.ts:119-128`) currently reads
`features.md`/`architecture.md`/`backlog.md` only. Extend it to also
read the design doc for any backlog row whose status isn't `done`:

```ts
export interface ExistingProjectContext {
  features: string;
  architecture: string;
  backlog: string;
  /** Design docs for any backlog row not yet `done` — see bug #19. */
  inProgressDesignDocs: { slug: string; content: string }[];
}
```

`ExistingProjectContext` (currently `intake-agent/src/promptContext.ts:100-104`)
gains the same field. `buildIncrementalSystemPrompt` includes it:

```ts
existing.inProgressDesignDocs.length > 0
  ? "In-progress design docs — their Outcome sections are the " +
    "authoritative record of exactly what's done and what's left. " +
    "If this request is a continuation of one of these, describe only " +
    "what's still listed as left, reusing that feature's title " +
    "exactly:\n\n" +
    existing.inProgressDesignDocs.map((d) => `### ${d.slug}\n\n${d.content}`).join("\n\n")
  : ""
```

The orchestrator threads the same `inProgressDesignDocs` through to
`runCodegenPhase` via `FeatureWorkflowContext`, and
`buildSystemPrompt`/`buildFrontendSystemPrompt` include it in the
*initial* prompt (today, `buildFeatureWorkflowInstructions` only tells
the model to read the matching design doc as the very last step before
finishing):

```ts
featureWorkflow.inProgressDesignDocs.length > 0
  ? "Existing design doc(s) for in-progress work — trust their Outcome " +
    "sections for what's already verified passing; do not re-explore or " +
    "re-verify what they already list as done, only work on what's " +
    "listed as left:\n\n" + ...
  : ""
```

This is a prompt-level instruction, not a hard block — final
verification (a real `bundle exec rspec`/`npx jest` run) still always
happens regardless of what the model believes, exactly as today.

## Out of scope

- A new machine-oriented snapshot file (JSON or otherwise) separate from
  the design doc — rejected in favor of reusing the doc the system
  already reliably writes (once part 1 lands), avoiding a second
  source of truth that could itself drift out of sync.
- NLP-based detection of "this message means resume" vs. "this is a new
  request" — unnecessary once Intake always has the in-progress design
  doc content in front of it; it decides for itself per request.
- Reducing final verification (still always a full, real test-suite run
  before declaring done/failed) — only the *starting* exploration is
  addressed here.
- A UI affordance for browsing a project's design docs — out of scope,
  no user-facing surface change beyond the chat replies themselves.
