export const PROJECT_STAGES = [
  "ideation",
  "product_requirements",
  "ux",
  "design",
  "development",
  "production",
] as const;

export type ProjectStage = (typeof PROJECT_STAGES)[number];

export interface Project {
  id: string;
  name: string;
  stage: ProjectStage;
  createdAt: string;
  /** Absolute path to this project's scaffolded codebase on disk. */
  workspacePath: string;
}

export interface CreateProjectInput {
  /** Pre-generated so it can be used to name the scaffold directory before the project is stored. */
  id: string;
  name: string;
  workspacePath: string;
}

export function isProjectStage(value: unknown): value is ProjectStage {
  return typeof value === "string" && (PROJECT_STAGES as readonly string[]).includes(value);
}

export interface ProjectStore {
  list(): Project[];
  get(id: string): Project | undefined;
  create(input: CreateProjectInput): Project;
  updateStage(id: string, stage: ProjectStage): Project | undefined;
}

/**
 * In-memory project registry — same rationale as chatStore.ts: this is the
 * Phase 0.5 vertical slice, not the real Orchestrator with persistence.
 *
 * A project is only ever inserted here after its workspace has already
 * been scaffolded on disk (see scaffold.ts) — there is no "project
 * without a workspace" state to represent.
 */
export function createInMemoryProjectStore(): ProjectStore {
  const projects = new Map<string, Project>();

  return {
    list() {
      return [...projects.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    get(id) {
      return projects.get(id);
    },
    create({ id, name, workspacePath }) {
      const project: Project = {
        id,
        name,
        stage: PROJECT_STAGES[0],
        createdAt: new Date().toISOString(),
        workspacePath,
      };
      projects.set(project.id, project);
      return project;
    },
    updateStage(id, stage) {
      const existing = projects.get(id);
      if (!existing) return undefined;
      const updated: Project = { ...existing, stage };
      projects.set(id, updated);
      return updated;
    },
  };
}
