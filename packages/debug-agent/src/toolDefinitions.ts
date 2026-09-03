import type { ToolDefinition } from "@app-builder/llm-client";

export type DebugSide = "backend" | "frontend";

/**
 * Deliberately NOT codegen-agent's TOOL_DEFINITIONS: those describe paths
 * as relative to the project's backend/ (or frontend/) root, but the
 * Debug Agent's fileTools root is the whole project — it needs to reach
 * CLAUDE.md/docs/backlog.md at the project root, not just its side's
 * code. Same five tool names, same dispatch (executeTool() in
 * codegen-agent doesn't care about descriptions), just accurate wording.
 * See docs/designs/debug-agent.md.
 */
export function buildDebugToolDefinitions(side: DebugSide): ToolDefinition[] {
  const codeDir = side === "backend" ? "backend/" : "frontend/";
  const service = side === "backend" ? "rails" : "frontend";
  const runCommandExamples =
    side === "backend"
      ? "bundle install, bin/rails runner, bundle exec rspec, etc."
      : "npm install, npx tsc --noEmit, npx jest, etc.";

  return [
    {
      type: "function",
      function: {
        name: "read_file",
        description:
          `Read the contents of a file. Paths are relative to the project ` +
          `root — use "${codeDir}..." for this pass's code, or bare paths ` +
          `like "CLAUDE.md" / "docs/backlog.md" / "docs/designs/TEMPLATE.md" ` +
          `for this project's own governance files.`,
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description:
          `Write (overwrite) a file. Paths are relative to the project ` +
          `root — use "${codeDir}..." for this pass's code, or a bare path ` +
          `like "docs/backlog.md" to log a bug per this project's own Bug ` +
          `workflow (see its CLAUDE.md). Creates parent directories as needed.`,
        parameters: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_dir",
        description: "List immediate entries in a directory. Path is relative to the project root.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_files",
        description:
          `Recursively list every file under a path (default: the whole ` +
          `project root), skipping .git/tmp/log/node_modules. Prefer this ` +
          `over repeated list_dir calls. Pass "${codeDir}" to scope to just ` +
          `this pass's own code.`,
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_files",
        description:
          `Grep-style search for a regex pattern across file contents under ` +
          `a path (default: the whole project root). Returns matching ` +
          `{path, line, text}. Pass "${codeDir}" to scope to just this ` +
          `pass's own code.`,
        parameters: {
          type: "object",
          properties: { pattern: { type: "string" }, path: { type: "string" } },
          required: ["pattern"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "run_command",
        description:
          `Run a shell command inside the project's ${side} Docker ` +
          `container (docker compose run --rm ${service}). Use this for ` +
          `${runCommandExamples}`,
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    },
  ];
}
