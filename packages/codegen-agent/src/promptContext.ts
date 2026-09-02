import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// packages/codegen-agent/src (or dist) -> repo root -> stack-spec
const DEFAULT_STACK_SPEC_DIR = path.resolve(here, "../../../stack-spec");

export interface BuildSpecField {
  name: string;
  type: string;
}

export interface BuildSpec {
  resource: string;
  fields: BuildSpecField[];
}

export async function loadBuildSpec(specPath: string): Promise<BuildSpec> {
  const raw = await readFile(specPath, "utf8");
  return JSON.parse(raw) as BuildSpec;
}

/**
 * Loads stack-spec/versions.yaml and every stack-spec/guidelines/*.md
 * file, verbatim, into one system prompt block — the "fixed set of docs,
 * always included" from the architecture blueprint. This is the first
 * code that reads stack-spec/ programmatically.
 */
export async function buildSystemPrompt(
  stackSpecDir: string = DEFAULT_STACK_SPEC_DIR,
): Promise<string> {
  const versions = await readFile(path.join(stackSpecDir, "versions.yaml"), "utf8");

  const guidelinesDir = path.join(stackSpecDir, "guidelines");
  const guidelineFiles = (await readdir(guidelinesDir)).filter((f) => f.endsWith(".md")).sort();
  const guidelineSections = await Promise.all(
    guidelineFiles.map(async (file) => {
      const content = await readFile(path.join(guidelinesDir, file), "utf8");
      return `### ${file}\n\n${content}`;
    }),
  );

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
    "Required sequence for the given build spec — do not stop before " +
      "every step below is actually done, not just planned:\n" +
      "1. Run `bundle install`.\n" +
      "2. Generate/write the migration and model for the resource.\n" +
      "3. Run the migration (e.g. `bin/rails db:migrate`).\n" +
      "4. Write the controller and serializer (per the API/serialization " +
      "guidelines below).\n" +
      "5. Write RSpec request/model specs for the resource.\n" +
      "6. Run `bundle exec rspec` yourself via run_command and fix any " +
      "failures before considering the work done.\n" +
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
