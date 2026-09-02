import type { Db } from "./db.js";
import {
  PROJECT_STAGES,
  type CreateProjectInput,
  type Project,
  type ProjectStage,
  type ProjectStore,
} from "./projectStore.js";

interface ProjectRow {
  id: string;
  name: string;
  stage: string;
  created_at: Date;
  workspace_path: string;
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    stage: row.stage as ProjectStage,
    createdAt: row.created_at.toISOString(),
    workspacePath: row.workspace_path,
  };
}

export function createPostgresProjectStore(db: Db): ProjectStore {
  return {
    async list() {
      const result = await db.query<ProjectRow>("SELECT * FROM projects ORDER BY created_at ASC");
      return result.rows.map(toProject);
    },

    async get(id) {
      const result = await db.query<ProjectRow>("SELECT * FROM projects WHERE id = $1", [id]);
      return result.rows[0] ? toProject(result.rows[0]) : undefined;
    },

    async create({ id, name, workspacePath }: CreateProjectInput) {
      const result = await db.query<ProjectRow>(
        `INSERT INTO projects (id, name, stage, created_at, workspace_path)
         VALUES ($1, $2, $3, now(), $4)
         RETURNING *`,
        [id, name, PROJECT_STAGES[0], workspacePath],
      );
      return toProject(result.rows[0]!);
    },

    async updateStage(id, stage) {
      const result = await db.query<ProjectRow>(
        "UPDATE projects SET stage = $2 WHERE id = $1 RETURNING *",
        [id, stage],
      );
      return result.rows[0] ? toProject(result.rows[0]) : undefined;
    },
  };
}
