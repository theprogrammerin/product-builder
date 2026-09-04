import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "@app-builder/llm-client";

export class PathEscapeError extends Error {}

/**
 * Resolves a tool-provided relative path against a fixed root, rejecting
 * anything that would escape it. This is the one place a bug here is a
 * security issue, not just a correctness one — the model's write_file
 * calls must never be able to touch anything outside the project's own
 * backend/ directory.
 */
export function resolveScoped(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new PathEscapeError(`Path escapes sandbox root: ${relativePath}`);
  }
  return resolved;
}

const SKIP_DIRS = new Set([".git", "tmp", "log", "node_modules"]);
const MAX_SEARCH_MATCHES = 200;

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface FileTools {
  readFile(relativePath: string): Promise<string>;
  writeFile(relativePath: string, content: string): Promise<void>;
  listDir(relativePath: string): Promise<string[]>;
  /** Recursively lists every file (not directory) under relativePath, skipping .git/tmp/log/node_modules. */
  listFiles(relativePath?: string): Promise<string[]>;
  /** Grep-style content search under relativePath. pattern is a regex, falling back to an escaped literal match if invalid. */
  searchFiles(pattern: string, relativePath?: string): Promise<SearchMatch[]>;
}

async function walkFiles(root: string, dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...(await walkFiles(root, path.join(dir, entry.name))));
    } else if (entry.isFile()) {
      files.push(path.relative(root, path.join(dir, entry.name)));
    }
  }

  return files;
}

function compilePattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped);
  }
}

export function createFileTools(root: string): FileTools {
  return {
    async readFile(relativePath) {
      return readFile(resolveScoped(root, relativePath), "utf8");
    },
    async writeFile(relativePath, content) {
      const resolved = resolveScoped(root, relativePath);
      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, content, "utf8");
    },
    async listDir(relativePath) {
      return readdir(resolveScoped(root, relativePath));
    },
    async listFiles(relativePath = ".") {
      const resolvedRoot = path.resolve(root);
      return walkFiles(resolvedRoot, resolveScoped(root, relativePath));
    },
    async searchFiles(pattern, relativePath = ".") {
      const resolvedRoot = path.resolve(root);
      const regex = compilePattern(pattern);
      const files = await walkFiles(resolvedRoot, resolveScoped(root, relativePath));
      const matches: SearchMatch[] = [];

      for (const file of files) {
        if (matches.length >= MAX_SEARCH_MATCHES) break;
        let content: string;
        try {
          content = await readFile(path.join(resolvedRoot, file), "utf8");
        } catch {
          continue; // skip unreadable/binary files
        }
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            matches.push({ path: file, line: i + 1, text: lines[i].trim() });
            if (matches.length >= MAX_SEARCH_MATCHES) break;
          }
        }
      }

      return matches;
    },
  };
}

export interface ProjectDocsTools {
  read(docPath: string): Promise<string>;
  write(docPath: string, content: string): Promise<void>;
}

// Deliberately a fixed allowlist, not a general project-root sandbox
// like the Debug Agent's — /build's own backend/frontend tools stay
// rooted at backend/frontend exactly as before this. Only these
// governance docs are reachable, and only by these two tools. See
// docs/designs/intake-iteration.md.
const PROJECT_DOC_PATTERN =
  /^(docs\/blueprints\/features\.md|docs\/blueprints\/architecture\.md|docs\/backlog\.md|CHANGELOG\.md|docs\/designs\/[a-z0-9-]+\.md)$/;

export function isProjectDocPath(docPath: string): boolean {
  return PROJECT_DOC_PATTERN.test(docPath);
}

export function createProjectDocsTools(workspaceRoot: string): ProjectDocsTools {
  return {
    async read(docPath) {
      if (!isProjectDocPath(docPath)) throw new Error(`Not a project doc path: ${docPath}`);
      return readFile(path.join(workspaceRoot, docPath), "utf8").catch(() => "(does not exist yet)");
    },
    async write(docPath, content) {
      if (!isProjectDocPath(docPath)) throw new Error(`Not a project doc path: ${docPath}`);
      const resolved = path.join(workspaceRoot, docPath);
      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, content, "utf8");
    },
  };
}

export const PROJECT_DOCS_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_project_doc",
      description:
        "Read one of this project's own governance docs: docs/blueprints/features.md, " +
        "docs/blueprints/architecture.md, docs/backlog.md, CHANGELOG.md, or docs/designs/<slug>.md. " +
        "Returns \"(does not exist yet)\" if the file isn't there yet (e.g. a design doc for a new feature).",
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
      name: "write_project_doc",
      description:
        "Write (overwrite) one of the same governance docs — creates docs/designs/<slug>.md if it " +
        "doesn't exist yet. Use this to follow this project's own Feature workflow before finishing.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
];

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file. Path is relative to the project's backend/ root.",
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
        "Write (overwrite) a file. Path is relative to the project's backend/ root. Creates parent directories as needed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List immediate entries in a directory. Path is relative to the project's backend/ root.",
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
        "Recursively list every file under a path (default: the whole backend/ root), skipping .git/tmp/log/node_modules. Prefer this over repeated list_dir calls when exploring the project structure.",
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
        "Grep-style search for a regex pattern across file contents under a path (default: the whole backend/ root). Returns matching {path, line, text}. Use this to find where something is defined or referenced instead of reading files one at a time.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a shell command inside the project's backend Docker container (docker compose run --rm rails). Use this for bundle install, bin/rails generate, bundle exec rspec, etc.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
];
