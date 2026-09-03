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
 * Builds the Codegen Agent's backend (Rails) system prompt. This is the
 * first code that reads stack-spec/ programmatically.
 */
export async function buildSystemPrompt(
  stackSpecDir: string = DEFAULT_STACK_SPEC_DIR,
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
    "Only respond with plain text and no tool calls once every step above " +
      "is genuinely complete. A final `bundle exec rspec` run will then " +
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
    "Only respond with plain text and no tool calls once every step above " +
      "is genuinely complete. A final `npx jest` run will then verify " +
      "your work regardless of what you claim — an empty or premature " +
      "'done' will be caught and reported as a failed run.",
  ].join("\n\n");
}
