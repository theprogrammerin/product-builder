import pg from "pg";

const { Pool } = pg;
export type Db = pg.Pool;

export class DbConfigError extends Error {}

export function loadDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL;
  if (!url) {
    throw new DbConfigError(
      "Missing required DATABASE_URL. Set it as an environment variable (see .env.example) " +
        "and make sure Postgres is running (`docker compose up -d` in packages/orchestrator).",
    );
  }
  return url;
}

export function createDb(connectionString: string): Db {
  return new Pool({ connectionString });
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    stage TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    workspace_path TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id SERIAL PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    role TEXT NOT NULL,
    content TEXT,
    tool_call_id TEXT,
    tool_name TEXT,
    tool_calls TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS running_instances (
    project_id TEXT PRIMARY KEY REFERENCES projects(id),
    status TEXT NOT NULL,
    last_error TEXT,
    started_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS running_components (
    project_id TEXT NOT NULL REFERENCES running_instances(project_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    port INTEGER NOT NULL,
    url TEXT NOT NULL,
    PRIMARY KEY (project_id, name)
  );
`;

/** Idempotent — safe to call on every startup. No migration framework for two tables. */
export async function ensureSchema(db: Db): Promise<void> {
  await db.query(SCHEMA_SQL);
}
