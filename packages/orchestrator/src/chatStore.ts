import type { ChatMessage } from "@app-builder/llm-client";

/**
 * Async throughout — the Postgres-backed implementation needs it. See
 * postgresChatStore.ts.
 */
export interface ChatSessionStore {
  get(projectId: string): Promise<ChatMessage[]>;
  append(projectId: string, messages: ChatMessage[]): Promise<void>;
}

/**
 * Per-process conversation history. Used by default in tests for speed
 * and isolation; the orchestrator itself defaults to the Postgres-backed
 * store (see postgresChatStore.ts) so history survives a restart.
 */
export function createInMemoryStore(): ChatSessionStore {
  const sessions = new Map<string, ChatMessage[]>();

  return {
    async get(projectId) {
      return sessions.get(projectId) ?? [];
    },
    async append(projectId, messages) {
      const existing = sessions.get(projectId) ?? [];
      sessions.set(projectId, [...existing, ...messages]);
    },
  };
}
