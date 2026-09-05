import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// packages/codegen-agent/src (or dist) -> repo root -> stack-spec
const DEFAULT_STACK_SPEC_DIR = path.resolve(here, "../../../stack-spec");

/**
 * The build spec is plain text (typically a short markdown brief from the
 * Intake Agent — see docs/designs/intake-agent-milestone-1.md) handed to
 * the model verbatim, the same way stack-spec/guidelines/*.md is. No
 * schema, no parsing: this model interprets it itself, same as any other
 * prose in its prompt.
 */
export async function loadBuildSpec(specPath: string): Promise<string> {
  return readFile(specPath, "utf8");
}

/**
 * Loads stack-spec/versions.yaml and every stack-spec/guidelines/*.md
 * file, verbatim — the "fixed set of docs, always included" from the
 * architecture blueprint. Shared by both the backend and frontend system
 * prompts below; each only differs in the task/sequence instructions
 * wrapped around this same fixed context.
 */
async function loadStackSpecContext(
  stackSpecDir: string,
): Promise<{ versions: string; guidelineSections: string[] }> {
  const versions = await readFile(path.join(stackSpecDir, "versions.yaml"), "utf8");

  const guidelinesDir = path.join(stackSpecDir, "guidelines");
  const guidelineFiles = (await readdir(guidelinesDir)).filter((f) => f.endsWith(".md")).sort();
  const guidelineSections = await Promise.all(
    guidelineFiles.map(async (file) => {
      const content = await readFile(path.join(guidelinesDir, file), "utf8");
      return `### ${file}\n\n${content}`;
    }),
  );

  return { versions, guidelineSections };
}

/**
 * Only included when the caller (the orchestrator's /build flow) also
 * supplies matching read_project_doc/write_project_doc tools — the
 * standalone CLI doesn't wire those up, so it omits this param entirely
 * and the model is never told about tools it doesn't actually have. See
 * docs/designs/intake-iteration.md.
 */
export interface FeatureWorkflowContext {
  /** kebab-case, used as docs/designs/<featureSlug>.md */
  featureSlug: string;
  /** true if this project already had real content before this run (see bug #16). */
  isIncremental: boolean;
  /**
   * Design docs for any of this project's backlog rows not yet
   * `done`/`fixed` — their Outcome sections are the authoritative record
   * of what's already verified passing and what's left, so the model
   * doesn't have to re-derive that by exploring the whole codebase from
   * scratch on every run. See docs/designs/build-context-and-resume.md.
   */
  inProgressDesignDocs?: { slug: string; content: string }[];
}

/** Matches the planning stage's own "## Plan" heading — see docs/designs/planning-stage.md. */
const PLAN_SECTION_PATTERN = /^##\s+Plan\s*$/im;

function buildInProgressDesignDocsSection(
  docs: { slug: string; content: string }[] | undefined,
  side: "backend" | "frontend",
): string {
  if (!docs || docs.length === 0) return "";
  const otherSide = side === "backend" ? "frontend" : "backend";
  const hasPlan = docs.some((d) => PLAN_SECTION_PATTERN.test(d.content));
  return (
    "Existing design doc(s) for in-progress work on this project — their " +
    "Outcome sections are authoritative for what's already verified " +
    "passing and what's left. Do not re-explore or re-verify what's " +
    "already listed as done here; focus your work on what's listed as " +
    "left. IMPORTANT: your tools only reach this project's " +
    `${side}/ directory — you cannot see or reach its ${otherSide}/ code ` +
    "at all, even though it exists. If what's listed as left is entirely " +
    `on the ${otherSide} side (nothing for you to do on ${side}/ for this ` +
    "request), do a single quick check that your own side's tests still " +
    "pass, then stop immediately with a short plain-text summary saying " +
    "so — do not repeatedly search for the other side's files or " +
    "directories (they are not mounted here and searching for them " +
    "again will not find them), and do not keep re-confirming the same " +
    "conclusion. (A real final test run still checks your work regardless, " +
    "same as always.)" +
    (hasPlan
      ? "\n\nOne of the doc(s) below contains a \"## Plan\" section — it " +
        "is your AUTHORITATIVE task list, not a starting point for your " +
        "own exploration. Do NOT enter code-discovery mode: do not call " +
        "list_files or list_dir broadly, do not read files the plan " +
        `doesn't name. Open exactly the files the plan lists for the ` +
        `${side} side, make the changes it describes, then run your ` +
        "verification command. Only fall back to broader exploration if " +
        "a named file doesn't exist or clearly doesn't match what the " +
        "plan says — if that happens, note the mismatch in your final " +
        "summary before proceeding, don't silently redo the planning " +
        "work yourself."
      : "") +
    "\n\n" +
    docs.map((d) => `### ${d.slug}\n\n${d.content}`).join("\n\n")
  );
}

/**
 * The planning stage's own system prompt (feature #22) — a bounded,
 * read-only pass, run only for incremental builds, before any
 * code-writing phase. Its tools are rooted at the project ROOT (not
 * backend/ or frontend/, like the Debug Agent's), and write_file/
 * run_command are simply never offered, so it cannot write or run
 * application code. See docs/designs/planning-stage.md.
 */
export function buildPlanningSystemPrompt(): string {
  return [
    "You are the Codegen Agent's PLANNING stage for an already-built " +
      "project. Your tools reach the WHOLE project root (both backend/ " +
      "and frontend/), but you must NOT write or modify any application " +
      "code — write_file isn't offered to you, only read/explore tools " +
      "plus read_project_doc/write_project_doc. Your only job is to " +
      "explore enough to answer two questions, then write the answer " +
      "into the design doc.",
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
    "If docs/designs/<slug>.md already has a \"## Plan\" section for " +
      "materially this same request, spot-check it's still accurate " +
      "(a couple of read_file calls, not a full re-survey) and reuse it " +
      "rather than re-deriving it from scratch.",
    'Write your answer as a "## Plan" section in the design doc via ' +
      "write_project_doc, starting with a line in EXACTLY this form on " +
      'its own: "Scope: backend-only" or "Scope: frontend-only" or ' +
      '"Scope: both" — then the file checklist per side below it.',
    "Respond with plain text and no further tool calls once the Plan " +
      "section is written — do not attempt to fix or write any " +
      "application code yourself, that's the next stage's job.",
  ].join("\n\n");
}

export function buildFeatureWorkflowInstructions(
  { featureSlug, isIncremental }: FeatureWorkflowContext,
  side?: "backend" | "frontend",
): string {
  return (
    "Before you finish — whether every step above fully succeeded or " +
    "not — follow this project's own Feature workflow (see its " +
    "CLAUDE.md), using real tool calls, not narration:\n" +
    `1. read_project_doc("docs/designs/${featureSlug}.md") — if it ` +
    "already exists (an earlier attempt at this same feature, or the " +
    "other phase's own earlier write in this same run), continue it " +
    "rather than starting over.\n" +
    `2. write_project_doc("docs/designs/${featureSlug}.md", ...) with ` +
    "Summary, Feature-set impact, Architecture impact, Design, and an " +
    "honest Outcome section — what you attempted, what's actually " +
    "passing, what isn't, and (if you didn't finish) exactly what's left.\n" +
    '3. read_project_doc("docs/backlog.md"), add or update this ' +
    "feature's row (status `done` only if your final test run " +
    "genuinely passed; `building` otherwise), linking the design doc above.\n" +
    '4. read_project_doc("docs/blueprints/features.md"), update it to ' +
    "describe the app's current, real capabilities — not aspirational " +
    "ones." +
    (isIncremental
      ? " This describes the WHOLE app, not just your new piece — keep " +
        "what's already accurate below and add your part."
      : "") +
    '\n5. write_project_doc("CHANGELOG.md", ...) with a new entry, prepended.' +
    (side
      ? "\n\nWhen writing any of the above, if part of what's left needs " +
        `work on the ${side === "backend" ? "frontend" : "backend"} side ` +
        `(not this ${side} run), phrase it precisely as needing a ` +
        `${side === "backend" ? "frontend" : "backend"}-phase build to ` +
        'complete it — e.g. "needs a frontend-phase build to wire the ' +
        'upload screen." Do NOT phrase it as unreachable, out of scope, ' +
        'or something "this agent cannot reach" — that reads as a ' +
        "permanent, architectural limit when it's really just which " +
        "phase does that part. A future run's matching phase can and " +
        "will reach it."
      : "")
  );
}

/**
 * Builds the Codegen Agent's backend (Rails) system prompt. This is the
 * first code that reads stack-spec/ programmatically.
 */
export async function buildSystemPrompt(
  stackSpecDir: string = DEFAULT_STACK_SPEC_DIR,
  featureWorkflow?: FeatureWorkflowContext,
): Promise<string> {
  const { versions, guidelineSections } = await loadStackSpecContext(stackSpecDir);

  return [
    "You are the Codegen Agent for an opinionated app-builder. You write " +
      "and run real code inside an already-scaffolded project until it " +
      "genuinely works — never just plausible-looking code you haven't run.",
    "You have six tools, all paths relative to the project's backend/ " +
      "directory: read_file, write_file, list_dir (immediate entries of " +
      "one directory), list_files (recursive — prefer this over repeated " +
      "list_dir calls), search_files (grep-style regex search across " +
      "file contents — prefer this over reading files one at a time when " +
      "looking for where something is defined or used), and run_command " +
      "(runs a shell command inside the project's Docker container).",
    "The build spec may describe ONE resource or SEVERAL related ones " +
      "(look for repeated `## Resource` blocks and an `## Associations` " +
      "section per resource using belongs_to/has_many/has_one). If there " +
      "is more than one, build them in dependency order: a resource that " +
      "another resource's `belongs_to` references must have its " +
      "migration and model written (and migrated) before the block that " +
      "references it, exactly like you'd do it by hand.\n\n" +
      "Required sequence — do not stop before every step below is " +
      "actually done, not just planned:\n" +
      "1. Run `bundle install` (once, not per resource).\n" +
      "2. For EACH resource, in dependency order: write its migration " +
      "and model (with its associations), run the migration, then write " +
      "its controller and serializer (per the API/serialization " +
      "guidelines below) and its RSpec request/model specs, before " +
      "moving to the next resource.\n" +
      "3. Once every resource above is done, run `bundle exec rspec` " +
      "yourself via run_command for the WHOLE suite and fix any failures " +
      "before considering the work done.\n" +
      "A small amount of initial exploration (listing/reading existing " +
      "files) is fine, but do not spend more than 2-3 tool calls " +
      "exploring before you start writing and running real code.",
    `Locked stack versions:\n\n${versions}`,
    `Guidelines you must follow:\n\n${guidelineSections.join("\n\n")}`,
    ...(featureWorkflow?.isIncremental
      ? [
          "IMPORTANT — this app already has real backend code in it. You " +
            "are NOT building from scratch: do not rename, delete, or " +
            "restructure an existing model/migration/controller unless " +
            "the build spec explicitly asks you to change it. A new " +
            "migration must not conflict with an existing table.",
        ]
      : []),
    ...(featureWorkflow?.inProgressDesignDocs?.length
      ? [buildInProgressDesignDocsSection(featureWorkflow.inProgressDesignDocs, "backend")]
      : []),
    ...(featureWorkflow ? [buildFeatureWorkflowInstructions(featureWorkflow, "backend")] : []),
    "Only respond with plain text and no tool calls once every step " +
      (featureWorkflow ? "above (code AND docs)" : "above") +
      " is genuinely complete. A final `bundle exec rspec` run will then " +
      "verify your work regardless of what you claim — an empty or " +
      "premature 'done' will be caught and reported as a failed run.",
  ].join("\n\n");
}

/**
 * Builds the Codegen Agent's frontend (Expo/React Native) system prompt
 * — the second, chained phase after a backend build passes. See
 * docs/designs/frontend-generation.md.
 */
export async function buildFrontendSystemPrompt(
  stackSpecDir: string = DEFAULT_STACK_SPEC_DIR,
  featureWorkflow?: FeatureWorkflowContext,
): Promise<string> {
  const { versions, guidelineSections } = await loadStackSpecContext(stackSpecDir);

  return [
    "You are the Codegen Agent for an opinionated app-builder — this run " +
      "is the FRONTEND phase, chained after a backend that already passed " +
      "its own tests. You write and run real code inside an " +
      "already-scaffolded project until it genuinely works — never just " +
      "plausible-looking code you haven't run.",
    "You have six tools, all paths relative to the project's frontend/ " +
      "directory: read_file, write_file, list_dir (immediate entries of " +
      "one directory), list_files (recursive — prefer this over repeated " +
      "list_dir calls), search_files (grep-style regex search across " +
      "file contents — prefer this over reading files one at a time when " +
      "looking for where something is defined or used), and run_command " +
      "(runs a shell command inside the project's Docker container).",
    "The build spec's `## Screens` section is the plan a human already " +
      "reviewed and approved — implement exactly those screens, not a " +
      "different or larger set you might independently prefer. Its " +
      "`## Resource`/`## Fields`/`## Associations` blocks tell you what " +
      "backend API endpoints already exist to wire screens to: standard " +
      "REST routes per the api-conventions guideline below (e.g. a " +
      "`Task` resource means `/api/v1/tasks`), nested one level under " +
      "its parent for a `belongs_to` association, exactly as the backend " +
      "phase would have built them. Do not read backend/ source to " +
      "confirm this — derive it from the spec and the guidelines, the " +
      "same way the backend phase derived its own conventions from them.\n\n" +
      "Required sequence — do not stop before every step below is " +
      "actually done, not just planned:\n" +
      "1. Run `npm install` (once).\n" +
      "2. Implement every screen from the `## Screens` section under " +
      "src/screens/, per the frontend-architecture guideline below " +
      "(Zustand store per bounded domain, React Native Paper components, " +
      "a single src/api/client.ts — no ad hoc fetch calls in screens).\n" +
      "3. Wire navigation (React Navigation) matching how the screens " +
      "connect per their described behavior.\n" +
      "4. Write a render test per screen and a unit test per store, per " +
      "the testing guideline below — mock the API client, no real " +
      "network calls in tests.\n" +
      "5. Run `npx tsc --noEmit` yourself via run_command and fix any " +
      "type errors.\n" +
      "6. Run `npx jest` yourself via run_command for the WHOLE suite and " +
      "fix any failures before considering the work done. Not every " +
      "failure is worth the same fight — see the testing guideline's " +
      "must-pass vs. nice-to-have split below (e.g. a third-party " +
      "component's accessibility-label wiring not matching what " +
      "`getByLabelText` expects is nice-to-have: `it.skip(...)` it with a " +
      "reason after one real attempt at a fix, rather than burning " +
      "iterations on it). Never skip a must-pass test just to force a " +
      "green run.\n" +
      "A small amount of initial exploration (listing/reading existing " +
      "files) is fine, but do not spend more than 2-3 tool calls " +
      "exploring before you start writing and running real code.",
    `Locked stack versions:\n\n${versions}`,
    `Guidelines you must follow:\n\n${guidelineSections.join("\n\n")}`,
    ...(featureWorkflow?.isIncremental
      ? [
          "IMPORTANT — this app already has real frontend code in it. " +
            "You are NOT building from scratch: do not remove or " +
            "restructure an existing screen/store/nav route unless the " +
            "build spec explicitly asks you to change it — integrate " +
            "your new screens into the existing navigation rather than " +
            "replacing it.",
        ]
      : []),
    ...(featureWorkflow?.inProgressDesignDocs?.length
      ? [buildInProgressDesignDocsSection(featureWorkflow.inProgressDesignDocs, "frontend")]
      : []),
    ...(featureWorkflow ? [buildFeatureWorkflowInstructions(featureWorkflow, "frontend")] : []),
    "Only respond with plain text and no tool calls once every step " +
      (featureWorkflow ? "above (code AND docs)" : "above") +
      " is genuinely complete. A final `npx jest` run will then verify " +
      "your work regardless of what you claim — an empty or premature " +
      "'done' will be caught and reported as a failed run.",
  ].join("\n\n");
}
