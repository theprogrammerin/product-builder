import type { ChatMessage } from "@app-builder/llm-client";

export interface ChatSessionStore {
  get(sessionId: string): ChatMessage[];
  append(sessionId: string, messages: ChatMessage[]): void;
}

/**
 * Per-process, per-session conversation history. Deliberately not
 * persisted — this is the Phase 0.5 vertical slice, not the real
 * Orchestrator; a restart losing in-progress chats is acceptable here.
 */
export function createInMemoryStore(): ChatSessionStore {
  const sessions = new Map<string, ChatMessage[]>();

  return {
    get(sessionId) {
      return sessions.get(sessionId) ?? [];
    },
    append(sessionId, messages) {
      const existing = sessions.get(sessionId) ?? [];
      sessions.set(sessionId, [...existing, ...messages]);
    },
  };
}
