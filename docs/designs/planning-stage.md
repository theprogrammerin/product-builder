# Design: A planning stage that scopes and sequences incremental builds

- **Backlog item**: [`docs/backlog.md`](../backlog.md) — Feature # 22
- **Status**: implemented — unit-tested (223 tests pass across all
  packages); live end-to-end verification against a real generated
  project (the "test_project" run that motivated this feature) not yet
  done — see Verification status below.

## Verification status

- New/updated unit tests: `parsePlanScope` (all three scope values,
  case-insensitive, safe `"both"` default when missing/unparseable),
  `mergeDesignDoc` (replace, append, no-op on empty content),
  `buildPlanningSystemPrompt()` (SCOPE/PLAN instructions, exact `Scope:`
  line forms, reuse-existing-plan instruction), the new hard
  "authoritative task list / do not enter code-discovery mode"
  instruction firing only when a design doc contains a `## Plan` heading
  (both backend and frontend variants), and `PLANNING_TOOL_DEFINITIONS`
  never including `write_file`/`run_command`. `npm run build` (full
  `tsc` across every package) is clean.
- **Live-verified 2026-09-04** on "test_project" (the exact feature that
  motivated this design, after 6 prior failed attempts): the planning
  stage explored both sides once (~35 tool calls, hitting two harmless
  "empty turn" nudges along the way), wrote a `## Plan` section, and
  correctly concluded `Plan: frontend-only. Skipping the backend
  phase — nothing for it to do.` The frontend phase then read the
  design doc plus only the ~14 specific files the plan named (not a
  fresh 30+-file survey), wrote the actual audio-upload/streaming
  wiring (`api/client.ts`, the store, both screens, their tests), fixed
  two real test failures it found along the way, and finished with 49/49
  tests passing and the app live. Full end-to-end success — this also
  incidentally verified bug #22 (raising `GLM_TIMEOUT_MS` to 180000
  fixed the repeated 60s timeouts that had blocked every prior attempt).

## Summary

Today, `defaultRunCodegenPhase` unconditionally runs the backend phase,
then (if it passes) the frontend phase — for every `/build`, fresh or
incremental. Each phase independently re-explores its entire relevant
directory from scratch every single run (confirmed live on
"test_project": 30+ tool calls reading real backend or frontend files
before any code gets written), and when a request is entirely one-sided
(e.g. "wire the upload screen" with the backend already done), the
unneeded phase still runs just to reach that conclusion, then the needed
phase re-derives from zero which files are actually relevant. Three
consecutive live runs on the same feature hit a `GLM request timed out
after 60000ms` at almost the same point — right after exploration
finished, before any `write_file` call — strongly suggesting the
accumulated context from that much re-exploration is what's tipping
calls over the timeout.

This adds a planning stage: a bounded, read-only pass (reusing
`runCodegenLoop`, not a new package) that runs before any code-writing
phase on an incremental build. It decides which side(s) actually need
work and writes a concrete, file-level plan into the design doc. The
orchestrator then skips whichever phase the plan says has nothing to do,
and the phase(s) that do run are told to execute the plan directly
rather than re-surveying the codebase. Because the plan is persisted
(bug #19's existing doc-writing infrastructure), it also survives
disruption: if a run dies mid-plan or mid-execution, the next run finds
the plan already there instead of starting from zero.

## Feature-set impact

- `/build`/`/proceed` against a project with existing work (incremental
  mode) now starts with a quick planning step before touching code: it
  reads what's needed, decides whether backend, frontend, or both need
  work, and writes a concrete plan into the design doc.
- If only one side needs work, the other side's phase is **skipped
  entirely** — no wasted phase invocation just to have it conclude
  "nothing for me here."
- The phase(s) that do run work from the plan (which files to touch,
  what each needs) instead of re-exploring the whole codebase from a
  standing start — cutting the 30+-call rediscovery seen live down to
  opening the specific files the plan names.
- If a run is interrupted (test failure or a thrown exception, e.g. a
  provider timeout) before finishing, the plan — once written — survives
  in the design doc; the next run's planning step finds it, confirms
  it's still accurate, and reuses it rather than re-deriving it.
- Fresh (from-scratch) builds are unaffected: planning only runs in
  incremental mode, since a from-scratch project always needs both sides
  in the existing backend-then-frontend sequence and has nothing yet to
  scope out.
- Final verification (a real `bundle exec rspec`/`npx jest` run before
  declaring done/failed) is unchanged — the plan guides *where to start
  looking*, it's never trusted as a substitute for actually running the
  tests.

## Architecture impact

No new components or packages — contained to `packages/codegen-agent`
and `packages/orchestrator`, reusing patterns already established by the
Debug Agent (project-root-scoped `fileTools`) and bug #19's epilogue
(a bounded, restricted-tool `runCodegenLoop` call).

- **`packages/codegen-agent`**: a new `buildPlanningSystemPrompt()` in
  `promptContext.ts`, and a new restricted `PLANNING_TOOL_DEFINITIONS` in
  `tools.ts` — the same five read/explore tool *names* `executeTool()`
  already dispatches (`read_file`, `list_dir`, `list_files`,
  `search_files`) plus `read_project_doc`/`write_project_doc`, minus
  `write_file` and `run_command` (the model is simply never offered
  those two, so it can't call them — no dispatch changes needed).
- **`packages/orchestrator`**: `defaultRunCodegenPhase` gains a planning
  step (only when `isIncremental`) before the existing backend/frontend
  sequence: a `runCodegenLoop` call with `fileTools` rooted at the
  *project root* (not `backend/`/`frontend/`, so the plan can see both
  sides), `PLANNING_TOOL_DEFINITIONS`, and a bounded iteration count.
  After it completes, the orchestrator re-reads
  `docs/designs/<featureSlug>.md` off disk, parses a `Scope:` line
  (same convention as the existing `# <Feature Title>` line used for
  slug derivation), and conditionally skips the backend and/or frontend
  phase. The freshly-read design doc content also replaces the stale,
  pre-run snapshot in `featureWorkflow.inProgressDesignDocs` for
  whichever phase(s) do run, so they see *this run's own plan*, not just
  whatever existed before planning started.
- `currentPhase` (used by bug #19/#21's exception-path epilogue) gains a
  third state, `"planning"` — its fileTools/dockerRunner reuse the
  planning step's own project-root tools, and `buildFeatureWorkflowInstructions`
  is called with no `side` (planning can reach both sides, so the
  "your tools only reach X" framing from bug #20/#21 doesn't apply).
- Bug #20's "stop early if nothing's left on your side" instruction stays
  as a defense-in-depth fallback for when a phase runs anyway (a stale
  or wrong plan, or planning itself failed and the orchestrator fell
  back to running both sides) and finds nothing to do.

## Components affected

- `packages/codegen-agent` — `src/promptContext.ts` (new
  `buildPlanningSystemPrompt()`), `src/tools.ts` (new
  `PLANNING_TOOL_DEFINITIONS`). [component blueprint](../blueprints/components/codegen-agent.md)
- `packages/orchestrator` — `src/app.ts`: `defaultRunCodegenPhase` (new
  planning step + conditional phase execution), `runFeatureWorkflowEpilogue`
  (`side` becomes `"planning" | "backend" | "frontend" | undefined`), a
  new `parsePlanScope()` helper. [component blueprint](../blueprints/components/orchestrator.md)

## Design

### Planning system prompt (codegen-agent)

```ts
export function buildPlanningSystemPrompt(): string {
  return [
    "You are the Codegen Agent's PLANNING stage for an already-built " +
      "project. Your tools reach the WHOLE project root (both backend/ " +
      "and frontend/), but you must NOT write or modify any application " +
      "code — no write_file, and it isn't offered to you. Your only job " +
      "is to explore enough to answer two questions, then write the " +
      "answer into the design doc.",
    "1. SCOPE: does this request need backend/ work, frontend/ work, or " +
      "both? A request is backend-only if it's purely about data, " +
      "endpoints, or business logic already exposed to the frontend; " +
      "frontend-only if the backend already exposes everything needed " +
      "(check the design doc's own Outcome section first — trust it); " +
      "both otherwise.",
    "2. PLAN: for each side in scope, list the SPECIFIC files to touch " +
      "and what each one needs — not prose, a checklist a coding pass " +
      "can execute without re-exploring. Read enough of each file " +
      "(don't guess from filenames alone) to be concrete.",
    "If docs/designs/<slug>.md already has a ## Plan section for " +
      "materially this same request, spot-check it's still accurate " +
      "(a couple of read_file calls, not a full re-survey) and reuse it " +
      "rather than re-deriving from scratch.",
    'Write your answer as a "## Plan" section in the design doc via ' +
      "write_project_doc, starting with a line in exactly this form: " +
      '"Scope: backend-only" or "Scope: frontend-only" or "Scope: both" ' +
      "— then the file checklist per side below it.",
    "Respond with plain text and no further tool calls once the Plan " +
      "section is written.",
  ].join("\n\n");
}
```

### Scope line + orchestrator wiring

```ts
const SCOPE_LINE_PATTERN = /^Scope:\s*(backend-only|frontend-only|both)\s*$/im;

export function parsePlanScope(designDoc: string): "backend-only" | "frontend-only" | "both" {
  const match = designDoc.match(SCOPE_LINE_PATTERN);
  return (match?.[1].toLowerCase() as ReturnType<typeof parsePlanScope>) ?? "both"; // safe default: never skip on doubt
}
```

In `defaultRunCodegenPhase`, only when `isIncremental`:

```ts
currentPhase = "planning";
await runCodegenLoop({
  llmClient: wrappedClient,
  systemPrompt: buildPlanningSystemPrompt(),
  buildSpec,
  fileTools: createFileTools(workspacePath), // project root, like Debug Agent
  dockerRunner: backendDocker, // required by RunOptions; run_command isn't offered so it's never called
  projectDocsTools,
  toolDefinitions: PLANNING_TOOL_DEFINITIONS,
  maxIterations: 20,
  onEvent: forward,
});
const planDoc = await readFile(path.join(workspacePath, "docs/designs", `${featureSlug}.md`), "utf8").catch(() => "");
const scope = parsePlanScope(planDoc);
const refreshedDesignDocs = mergeDesignDoc(inProgressDesignDocs, featureSlug, planDoc);
currentPhase = "backend";
if (scope !== "frontend-only") {
  // run backend phase, using refreshedDesignDocs in its featureWorkflow
}
currentPhase = "frontend";
if (scope !== "backend-only" && backendPassed) {
  // run frontend phase, using refreshedDesignDocs in its featureWorkflow
}
```

(`mergeDesignDoc` is a small helper: replace the entry for `featureSlug`
in the array, or append it, so the coding phase(s) see this run's
just-written plan instead of the pre-run snapshot.)

### Forcing plan execution, not re-discovery

Feeding the plan into context isn't enough on its own — the existing
"don't re-verify what's done" instruction (bug #19) doesn't tell a
coding phase to skip *discovery*, only re-verification of already-passing
work. `buildInProgressDesignDocsSection()` gains an explicit check: when
the design doc content contains a `## Plan` heading, append a hard
instruction (side-aware, so it names the model's own side):

```
This design doc contains a Plan section — it is your AUTHORITATIVE task
list, not a starting point for your own exploration. Do NOT enter
code-discovery mode: do not call list_files or list_dir broadly, do not
read files the plan doesn't name. Open exactly the files the plan lists
for the <backend|frontend> side, make the changes it describes, then run
your verification command. Only fall back to broader exploration if a
named file doesn't exist or clearly doesn't match what the plan says —
if that happens, note the mismatch in your final summary before
proceeding, don't silently redo the planning work yourself.
```

This is deliberately a hard instruction ("do NOT," not "prefer not to")
— softer phrasing already exists in the current prompts (the backend
system prompt's own "don't spend more than 2-3 tool calls exploring")
and the live evidence (30+ exploration calls per run) shows it isn't
enough on its own once a phase decides broader context is warranted.

If the planning step itself throws (a provider timeout during planning),
the exception-path epilogue runs with `side: undefined` (project-root
tools, no phase framing) and `scope` defaults to `"both"` — the
orchestrator falls back to today's unconditional backend-then-frontend
sequence rather than guessing wrong and skipping real work.

## Out of scope

- Re-planning mid-run if a coding phase discovers the plan was wrong —
  bug #20's "stop early" instruction is the fallback for that case, not
  a live re-plan loop.
- A UI affordance for viewing/editing the plan directly — it's a section
  of the same design doc already viewable by reading that file.
- Extending planning to fresh (non-incremental) builds — deferred; the
  problem this solves hasn't been observed there.
