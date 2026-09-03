import type { Db } from "./db.js";
import type { RunComponent, RunInstance, RunStatus, RunStore } from "./runStore.js";

interface InstanceRow {
  project_id: string;
  status: string;
  last_error: string | null;
  updated_at: Date;
}

interface ComponentRow {
  name: string;
  port: number;
  url: string;
}

export function createPostgresRunStore(db: Db): RunStore {
  return {
    async get(projectId) {
      const instanceResult = await db.query<InstanceRow>(
        "SELECT * FROM running_instances WHERE project_id = $1",
        [projectId],
      );
      const row = instanceResult.rows[0];
      if (!row) return undefined;

      const componentsResult = await db.query<ComponentRow>(
        "SELECT name, port, url FROM running_components WHERE project_id = $1 ORDER BY name ASC",
        [projectId],
      );

      const instance: RunInstance = {
        projectId: row.project_id,
        status: row.status as RunStatus,
        lastError: row.last_error ?? undefined,
        updatedAt: row.updated_at.toISOString(),
        components: componentsResult.rows.map((c): RunComponent => ({ name: c.name, port: c.port, url: c.url })),
      };
      return instance;
    },

    async setStatus(projectId, status, lastError) {
      await db.query(
        `INSERT INTO running_instances (project_id, status, last_error, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (project_id) DO UPDATE SET status = $2, last_error = $3, updated_at = now()`,
        [projectId, status, lastError ?? null],
      );
      await db.query("DELETE FROM running_components WHERE project_id = $1", [projectId]);
    },

    async setLive(projectId, components) {
      await db.query(
        `INSERT INTO running_instances (project_id, status, last_error, started_at, updated_at)
         VALUES ($1, 'live', NULL, now(), now())
         ON CONFLICT (project_id) DO UPDATE SET status = 'live', last_error = NULL, started_at = now(), updated_at = now()`,
        [projectId],
      );
      await db.query("DELETE FROM running_components WHERE project_id = $1", [projectId]);
      for (const component of components) {
        await db.query(
          "INSERT INTO running_components (project_id, name, port, url) VALUES ($1, $2, $3, $4)",
          [projectId, component.name, component.port, component.url],
        );
      }
    },
  };
}
