# Design: Intake Agent supports continuing/extending an already-built project

- **Backlog item**: [`docs/backlog.md`](../backlog.md) — Feature # 18
  (folds in bug # 16 as a hard prerequisite)
- **Status**: implemented — unit-tested (191 tests pass across all
  packages) and live-verified against a real generated project; see
  Verification status below.

## Summary

Today `/build <description>` always assumes a blank-slate project — the
Intake Agent has zero awareness of existing code, and the Codegen Agent's
prompts, while general enough in *language*, were only ever exercised
building everything in one shot. There's no way to say "add a feature to
the app you already built" without risking a rewrite of what's there.
This adds that path, reusing `/build`'s existing review-gate shape
(no new command): the orchestrator detects whether a project already has
real work in it and switches Intake and Codegen into an incremental mode
that treats the request as a delta.

The detection and the "what already exists" context both come from the
project's own `docs/blueprints/features.md` — not a stored pass/fail
flag — specifically so a follow-up request works correctly even after a
build that failed its final verification: whatever was actually
attempted is what the next request builds on, not a wiped slate. This
requires a real prerequisite fix (bug #16): the Codegen Agent has never
once updated `docs/blueprints/features.md`/`architecture.md`, logged a
`docs/backlog.md` row, or added a `CHANGELOG.md` entry — despite the
project's own `CLAUDE.md` mandating exactly that. This feature makes the
Codegen Agent follow its own project's Feature workflow for real, the
same way the Debug Agent already follows that project's Bug workflow —
including publishing a per-feature design doc that records the plan and
where a build was left off, so a later continuation (or a human) has a
real record to read, not just a one-line summary.

## Feature-set impact

- `/build <description>` behaves the same as today for a project that's
  never had a resource successfully written to it yet (`features.md`
  still reads the scaffold's stub text).
- For a project with real content already, `/build <description>`
  switches into **incremental mode**: the Intake Agent is shown the
  project's current `features.md`/`architecture.md`/`backlog.md` and
  proposes the request as an addition — new resources/screens, or a
  continuation of an unfinished one — not a full redescription. The
  proposed plan still goes through the same review → `/proceed` gate as
  today.
- Every completed `/proceed` (fresh or incremental, regardless of
  whether its final test run fully passed) now leaves the project with:
  a `docs/backlog.md` Feature requests row, a `docs/designs/<slug>.md`
  recording the plan and its actual outcome, an updated
  `docs/blueprints/features.md`, and a `CHANGELOG.md` entry — the
  project genuinely governs itself the way its own `CLAUDE.md` already
  claims, for features as well as bugs.
- If the same request (or a re-run after a failure) produces a similarly
  titled feature, Codegen finds the existing `docs/designs/<slug>.md`
  already there and continues it rather than starting a duplicate.

## Architecture impact

No new components.

- **`packages/orchestrator`**: `/build`'s handler reads the target
  project's `docs/blueprints/features.md` (and, if not the stub,
  `architecture.md`/`backlog.md` too) directly off disk before calling
  Intake — no new persisted state, no DB schema change. It picks the
  Intake prompt variant, extracts a feature title from Intake's reply to
  derive a `docs/designs/<slug>.md` filename, and threads that slug plus
  an `isIncremental` flag through `/proceed` into both Codegen phases.
- **`packages/intake-agent`**: gains an incremental system-prompt
  variant that takes the existing-state context and instructs Intake to
  describe a delta; its output format gains one leading `# <Feature
  Title>` line (used only for slug derivation — not new structured
  parsing, same "no schema" philosophy as the rest of the spec).
- **`packages/codegen-agent`**: two new tools
  (`read_project_doc`/`write_project_doc`), scoped to a fixed allowlist
  of project-root doc paths — not a general project-root sandbox like
  Debug Agent's, since `/build`'s backend/frontend tools stay rooted at
  `backend/`/`frontend/` exactly as today. Both system prompts gain a
  mandatory final step: follow the project's own Feature workflow before
  finishing, success or not.

## Components affected

- `packages/orchestrator` — `src/app.ts`'s `/build` handler and
  `defaultRunCodegenPhase`/`RunCodegenPhase`.
  [component blueprint](../blueprints/components/orchestrator.md)
- `packages/intake-agent` — new incremental prompt variant + existing-
  state context param. [component blueprint](../blueprints/components/intake-agent.md)
- `packages/codegen-agent` — `src/tools.ts` (two new tools), `src/agent.ts`
  (`executeTool`, `RunOptions`), `src/promptContext.ts` (both system
  prompts). [component blueprint](../blueprints/components/codegen-agent.md)
- `stack-spec/template` — no new files; `docs/blueprints/features.md`,
  `docs/backlog.md`, `docs/designs/TEMPLATE.md`, `CHANGELOG.md` already
  exist (features #1/#8) and are simply used for the first time.

## Design

### Detecting fresh vs. incremental (orchestrator)

```ts
const STUB_MARKER = "Nothing built yet beyond the initial structural skeleton";

async function readProjectDocs(workspacePath: string) {
  const featuresPath = path.join(workspacePath, "docs/blueprints/features.md");
  const features = await readFile(featuresPath, "utf8").catch(() => "");
  const isFresh = features.includes(STUB_MARKER) || features === "";
  if (isFresh) return { isFresh: true as const };

  const [architecture, backlog] = await Promise.all([
    readFile(path.join(workspacePath, "docs/blueprints/architecture.md"), "utf8").catch(() => ""),
    readFile(path.join(workspacePath, "docs/backlog.md"), "utf8").catch(() => ""),
  ]);
  return { isFresh: false as const, features, architecture, backlog };
}
```

Called once at the top of `/build`'s handler, before invoking
`runIntakePhase`. No new table, no flag to keep in sync — it just reads
whatever's really there.

### Intake Agent: incremental prompt variant

```ts
export function buildIncrementalSystemPrompt(existing: {
  features: string; architecture: string; backlog: string;
}): string {
  return [
    buildSystemPrompt(), // same resource/screens shape, reused verbatim
    "IMPORTANT — this app already has real work in it. You are NOT " +
      "describing a new app from scratch: describe only the new " +
      "resource(s)/screen(s) the request needs, or a continuation of " +
      "an already-in-progress one. Do not redescribe anything that " +
      "already exists below unless the request explicitly asks to " +
      "change it.",
    `What already exists (this project's own docs/blueprints/features.md):\n\n${existing.features}`,
    `Current architecture (docs/blueprints/architecture.md):\n\n${existing.architecture}`,
    `Feature history, including anything still in progress (docs/backlog.md):\n\n${existing.backlog}`,
    "Start your response with a single line `# <Feature Title>` (a " +
      "short, specific title for this request — used to name its design " +
      "doc), then the resource/screens blocks as usual.",
  ].join("\n\n");
}
```

`runIntake` already takes `systemPrompt` as a plain string param
(`intake-agent/src/agent.ts:47`) — no signature change needed there, only
which prompt-builder the orchestrator calls.

Fresh-mode output also gains the `# <Feature Title>` leading line (added
to `buildSystemPrompt()`'s existing shape) so slug derivation works
identically in both modes.

### Slug derivation (orchestrator)

```ts
function slugify(title: string): string {
  return title.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const titleMatch = /^#\s+(.+)$/m.exec(intakeResult.content);
const featureSlug = titleMatch ? slugify(titleMatch[1]) : `feature-${Date.now()}`;
```

Stored alongside the pending spec (`pendingSpecs` already keys by
`projectId`; extend its value from a bare string to `{ spec, featureSlug,
isIncremental }`) and threaded into `/proceed`'s call to
`defaultRunCodegenPhase`.

### New tools: `read_project_doc` / `write_project_doc`

Allowlist, not a general project-root sandbox:

```ts
const PROJECT_DOC_PATTERN =
  /^(docs\/blueprints\/features\.md|docs\/blueprints\/architecture\.md|docs\/backlog\.md|CHANGELOG\.md|docs\/designs\/[a-z0-9-]+\.md)$/;

export async function readProjectDoc(workspaceRoot: string, docPath: string): Promise<string> {
  if (!PROJECT_DOC_PATTERN.test(docPath)) throw new Error(`Not a project doc path: ${docPath}`);
  return readFile(path.join(workspaceRoot, docPath), "utf8").catch(() => "(does not exist yet)");
}

export async function writeProjectDoc(workspaceRoot: string, docPath: string, content: string): Promise<void> {
  if (!PROJECT_DOC_PATTERN.test(docPath)) throw new Error(`Not a project doc path: ${docPath}`);
  await mkdir(path.dirname(path.join(workspaceRoot, docPath)), { recursive: true });
  await writeFile(path.join(workspaceRoot, docPath), content, "utf8");
}
```

`RunOptions` gains an optional `projectDocsTools?: { read; write }`;
`executeTool()` gains two more `case`s dispatching to them when present.
Tool definitions (two more entries, appended to `TOOL_DEFINITIONS` only
when `projectDocsTools` is supplied — existing callers unaffected):

```ts
{ name: "read_project_doc", description: "Read one of this project's own governance docs (docs/blueprints/features.md, docs/blueprints/architecture.md, docs/backlog.md, CHANGELOG.md, or docs/designs/<slug>.md).", parameters: { path: string } }
{ name: "write_project_doc", description: "Write (overwrite) one of the same docs — creates docs/designs/<slug>.md if it doesn't exist yet.", parameters: { path: string, content: string } }
```

### Codegen system prompts: mandatory final step

Both `buildSystemPrompt`/`buildFrontendSystemPrompt` take a new param
(`{ featureSlug, isIncremental }`) and append:

```
Before you finish — whether every step above fully succeeded or not —
follow this project's own Feature workflow (see its CLAUDE.md):
1. read_project_doc("docs/designs/<featureSlug>.md") — if it already
   exists (e.g. from an earlier attempt at this same feature, or the
   backend phase's own earlier write in this same run), continue it
   rather than starting over.
2. write_project_doc(...) that file with Summary, Feature-set impact,
   Architecture impact, Design, and an honest Outcome section — what you
   attempted, what's actually passing, what isn't, and (if you didn't
   finish) exactly what's left.
3. read_project_doc("docs/backlog.md"), add or update this feature's
   row (status `done` only if your final test run genuinely passed;
   `building` otherwise), linking the design doc above.
4. read_project_doc("docs/blueprints/features.md"), update it to
   describe the app's current, real capabilities — not aspirational
   ones.
5. write_project_doc("CHANGELOG.md", ...) with a new entry, prepended.
This is not optional narration — do it with real tool calls, the same
way you write and run code.
```

For an incremental run, step 4's prompt text also says: "this describes
the WHOLE app, not just your new piece — keep what's already accurate
below and add your part," with the existing `features.md` content
already shown earlier in the prompt (same existing-state context Intake
saw).

`defaultRunCodegenPhase` passes `{ featureSlug, isIncremental }` into
both `buildSystemPrompt()`/`buildFrontendSystemPrompt()` calls and
constructs `projectDocsTools` from `workspacePath` once, reused for both
phases.

## Out of scope

- Any UI change — the web chat already just renders whatever `/build`
  replies with; no new chat command, no new footer/progress element.
- Structured (JSON) build specs — the incremental prompt still produces
  the same "no schema" markdown shape as today.
- Automatically deciding *which* existing feature a request continues
  vs. treats as new — that's left to Intake's judgment (via the title it
  picks) and, downstream, to whether that title happens to slugify to an
  existing `docs/designs/<slug>.md` file. No fuzzy matching against past
  titles.
- Retrofitting already-generated test projects' `features.md`/backlog
  rows for builds that already happened before this feature shipped —
  only builds from here on get the new doc discipline.

## Verification status (2026-09-04)

Live-verified against a real generated project (a "Simple Habit
Tracker" `/build`), with a real, weaker model (OpenRouter's free
`cohere/north-mini-code`, used after the primary GLM endpoint hit
persistent 503s/timeouts — see below):

- The `# <Feature Title>` line came through correctly from the real
  Intake call (`# Simple Habit Tracker`), and the orchestrator correctly
  derived `simple-habit-tracker` as the slug.
- **A real gap found live, not anticipated in the original design**: the
  Feature workflow instructions embedded in the main backend/frontend
  prompt only run when the model reaches a *natural* stop — but this
  model instead burned its entire 25-iteration budget still actively
  fighting rspec failures (16-17 examples, 13-15 failures across two
  attempts) and never reached that step. `docs/blueprints/features.md`
  was left at the scaffold's stub text with zero record of the attempt —
  precisely the case the design doc's own motivation cared about most
  ("where was it left at the end of a build"). Fixed with a dedicated,
  bounded epilogue pass (`runFeatureWorkflowEpilogue` in
  `packages/orchestrator/src/app.ts`): whenever the final authoritative
  test run doesn't pass (whether the model converged and was simply
  wrong, or never converged at all), a follow-up `runCodegenLoop` call —
  scoped to *only* the `read_project_doc`/`write_project_doc` tools, told
  explicitly not to touch application code — writes the real outcome.
- First live attempt at the epilogue (6-iteration budget) confirmed the
  mechanism fires and produces genuinely good content — a real design
  doc with an honest "Status: building" outcome, specific failure
  counts, what was implemented, what's failing, and concrete remaining
  work — but only got through the design doc itself before running out
  of room; `backlog.md`/`features.md`/`CHANGELOG.md` were still
  untouched. Raised the budget to 14 (these are cheap doc-only calls, no
  Docker/test execution, so slack is nearly free) and strengthened the
  prompt to explicitly warn against spending the whole budget on the
  first doc. This specific fix (the number 14, and the budgeting
  instruction) was verified by unit tests and reasoning about the
  observed 4-iterations-for-3-docs consumption rate, but a second live
  run to directly confirm all four docs land was blocked by OpenRouter's
  free-tier rate limit (429) after this session's testing volume — see
  below.
- Provider notes: `api.sarvam.ai` (the primary configured endpoint) hit
  persistent 503s/60s timeouts mid-session, same known flakiness pattern
  documented elsewhere in this project's history. Switched to a
  previously-configured OpenRouter fallback to continue verification;
  that endpoint's free-tier model then hit its own rate limit (429)
  after the volume of live testing this feature required. Reverted
  `packages/orchestrator/.env` back to the `sarvam` config afterward
  (matching its state before this session) rather than leaving the
  fallback active.
- Confirmed unaffected by all of the above: 191 tests pass across every
  package (`codegen-agent` 56, `debug-agent` 14, `intake-agent` 17,
  `llm-client` 20, `orchestrator` 70, `run-agent` 14).
