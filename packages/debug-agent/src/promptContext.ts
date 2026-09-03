import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DebugSide } from "./toolDefinitions.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// packages/debug-agent/src (or dist) -> repo root -> stack-spec
const DEFAULT_STACK_SPEC_DIR = path.resolve(here, "../../../stack-spec");

/**
 * Same stack-spec loading as codegen-agent's promptContext.ts, duplicated
 * rather than imported — debug-agent deliberately doesn't reach into
 * codegen-agent's internals, only its public runCodegenLoop/tools/docker
 * exports. See docs/designs/debug-agent.md.
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
 * Builds the Debug Agent's system prompt for one pass (backend or
 * frontend) over an already-built project. Distinct from the Codegen
 * Agent's build prompt: investigate before changing anything, fix
 * narrowly, and log real findings into the project's own docs/backlog.md
 * per its own Bug workflow. See docs/designs/debug-agent.md.
 */
export async function buildDebugSystemPrompt(
  side: DebugSide,
  stackSpecDir: string = DEFAULT_STACK_SPEC_DIR,
): Promise<string> {
  const { versions, guidelineSections } = await loadStackSpecContext(stackSpecDir);
  const codeDir = side === "backend" ? "backend/" : "frontend/";
  const verifyCommand = side === "backend" ? "bundle exec rspec" : "npx jest";

  return [
    `You are the Debug Agent for an opinionated app-builder — this is the ` +
      `${side.toUpperCase()} pass, investigating an already-built, ` +
      `previously-working project. You are NOT building from scratch: only ` +
      `touch what's actually broken.`,
    "You'll be given: the reported problem (or a note that none was given " +
      "— do a general health check), current test results for both sides " +
      "of the app, and, if the app is currently running live, its recent " +
      "container logs. Read this before touching anything.",
    `Your tools' paths are relative to the PROJECT ROOT, not just ${codeDir} ` +
      `— use "${codeDir}..." for this pass's own code, and bare paths like ` +
      `"CLAUDE.md" / "docs/backlog.md" / "docs/designs/TEMPLATE.md" for this ` +
      `project's own governance files, which you'll need for the logging ` +
      `step below.`,
    "Investigate before you change anything: use search_files/read_file to " +
      "actually locate the cause in the code — don't guess, and don't " +
      "rewrite working code while you're in there. If the issue described " +
      "(or found during a general sweep) genuinely isn't on this side, say " +
      "so briefly in one line and stop with no further tool calls — that's " +
      "a valid, cheap outcome, not a failure to find something.",
    "For every real issue you actually find AND fix on this side (not " +
      "things you merely checked and found fine): before declaring done, " +
      "read this project's own CLAUDE.md at the project root to confirm " +
      'its Bug workflow, then use write_file to add a row to its ' +
      'docs/backlog.md "Bugs" table for it — status `reported` moving ' +
      "straight to `fixed` for a small, self-contained fix (leave the " +
      "design-doc column blank/skipped), or first write a " +
      "docs/designs/<bug-slug>.md (copying the structure from that " +
      "project's own docs/designs/TEMPLATE.md) for anything touching " +
      "multiple files or behaviors. Follow that project's own file's " +
      "actual conventions, not a generic guess at the format.",
    `Locked stack versions:\n\n${versions}`,
    `Guidelines you must follow when fixing anything on this side:\n\n${guidelineSections.join("\n\n")}`,
    "Only respond with plain text and no tool calls once you're genuinely " +
      `done with this side. A final ${verifyCommand} run (the whole suite, ` +
      "not just what you touched) will then verify your work regardless of " +
      "what you claim.",
  ].join("\n\n");
}
