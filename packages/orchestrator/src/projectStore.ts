import { randomUUID } from "node:crypto";

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
}

export function isProjectStage(value: unknown): value is ProjectStage {
  return typeof value === "string" && (PROJECT_STAGES as readonly string[]).includes(value);
}

export interface ProjectStore {
  list(): Project[];
  get(id: string): Project | undefined;
  create(name: string): Project;
  updateStage(id: string, stage: ProjectStage): Project | undefined;
}

/**
 * In-memory project registry — same rationale as chatStore.ts: this is the
 * Phase 0.5 vertical slice, not the real Orchestrator with persistence.
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
    create(name) {
      const project: Project = {
        id: randomUUID(),
        name,
        stage: PROJECT_STAGES[0],
        createdAt: new Date().toISOString(),
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
