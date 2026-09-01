import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// packages/orchestrator/src (or dist) -> repo root -> stack-spec/template
const DEFAULT_TEMPLATE_DIR = path.resolve(here, "../../../stack-spec/template");

export interface ScaffoldConfig {
  /** Root directory under which each project gets its own <id> subdirectory. */
  filesDir: string;
}

export function loadScaffoldConfig(env: NodeJS.ProcessEnv = process.env): ScaffoldConfig {
  return { filesDir: env.PROJECT_FILES_DIR ?? "./generated-projects" };
}

/**
 * Copies the locked-stack template into a fresh directory for one
 * project. Deterministic file copy — no LLM involved. Throws if the
 * destination already exists rather than silently overwriting, since a
 * collision on a freshly generated project id indicates a bug upstream.
 */
export async function scaffoldProject(
  projectId: string,
  config: ScaffoldConfig,
  templateDir: string = DEFAULT_TEMPLATE_DIR,
): Promise<string> {
  await mkdir(config.filesDir, { recursive: true });
  const destination = path.resolve(config.filesDir, projectId);
  await cp(templateDir, destination, { recursive: true, force: false, errorOnExist: true });
  return destination;
}
