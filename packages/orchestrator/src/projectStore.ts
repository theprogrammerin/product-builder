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

/**
 * Async throughout — the Postgres-backed implementation needs it, and
 * the in-memory one just resolves immediately. See postgresProjectStore.ts.
 */
export interface ProjectStore {
  list(): Promise<Project[]>;
  get(id: string): Promise<Project | undefined>;
  create(input: CreateProjectInput): Promise<Project>;
  updateStage(id: string, stage: ProjectStage): Promise<Project | undefined>;
}

/**
 * In-memory project registry — used by default in tests for speed and
 * isolation; the orchestrator itself defaults to the Postgres-backed
 * store (see postgresProjectStore.ts) so projects survive a restart.
 *
 * A project is only ever inserted here after its workspace has already
 * been scaffolded on disk (see scaffold.ts) — there is no "project
 * without a workspace" state to represent.
 */
export function createInMemoryProjectStore(): ProjectStore {
  const projects = new Map<string, Project>();

  return {
    async list() {
      return [...projects.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async get(id) {
      return projects.get(id);
    },
    async create({ id, name, workspacePath }) {
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
    async updateStage(id, stage) {
      const existing = projects.get(id);
      if (!existing) return undefined;
      const updated: Project = { ...existing, stage };
      projects.set(id, updated);
      return updated;
    },
  };
}
