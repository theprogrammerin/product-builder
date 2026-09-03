export type RunStatus = "starting" | "live" | "stopping" | "stopped" | "failed";

export interface RunComponent {
  /** docker-compose service name, e.g. "rails", "frontend" — not a fixed backend/frontend pair. */
  name: string;
  port: number;
  url: string;
}

export interface RunInstance {
  projectId: string;
  status: RunStatus;
  lastError?: string;
  updatedAt: string;
  /** Empty unless status is "live" — a one-to-many mapping, not fixed columns. See docs/designs/run-deploy-agent.md. */
  components: RunComponent[];
}

/**
 * Async throughout — the Postgres-backed implementation needs it. See
 * postgresRunStore.ts. Unlike projectStore/chatStore, this tracks live
 * process state (is something actually running right now), not just
 * durable records — see the "can go stale" limitation in the design doc.
 */
export interface RunStore {
  get(projectId: string): Promise<RunInstance | undefined>;
  /** Sets status without touching components — used for starting/stopping/failed, where any previously live ports are no longer valid. */
  setStatus(projectId: string, status: Exclude<RunStatus, "live">, lastError?: string): Promise<void>;
  /** Sets status to "live" and replaces the component list wholesale. */
  setLive(projectId: string, components: RunComponent[]): Promise<void>;
}

export function createInMemoryRunStore(): RunStore {
  const instances = new Map<string, RunInstance>();

  return {
    async get(projectId) {
      return instances.get(projectId);
    },
    async setStatus(projectId, status, lastError) {
      instances.set(projectId, {
        projectId,
        status,
        lastError,
        updatedAt: new Date().toISOString(),
        components: [],
      });
    },
    async setLive(projectId, components) {
      instances.set(projectId, {
        projectId,
        status: "live",
        updatedAt: new Date().toISOString(),
        components,
      });
    },
  };
}
