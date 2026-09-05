import type { ChatMessage, ToolCall } from "@app-builder/llm-client";
import type { Db } from "./db.js";
import type { ChatSessionStore } from "./chatStore.js";

interface ChatMessageRow {
  role: string;
  content: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  tool_calls: string | null;
  created_at: string | Date;
}

function toChatMessage(row: ChatMessageRow): ChatMessage {
  return {
    role: row.role as ChatMessage["role"],
    content: row.content,
    ...(row.tool_call_id ? { toolCallId: row.tool_call_id } : {}),
    ...(row.tool_name ? { name: row.tool_name } : {}),
    ...(row.tool_calls ? { toolCalls: JSON.parse(row.tool_calls) as ToolCall[] } : {}),
    // See ChatMessage.createdAt (feature #23) — read-only, for the web UI.
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export function createPostgresChatStore(db: Db): ChatSessionStore {
  return {
    async get(projectId) {
      const result = await db.query<ChatMessageRow>(
        "SELECT * FROM chat_messages WHERE project_id = $1 ORDER BY id ASC",
        [projectId],
      );
      return result.rows.map(toChatMessage);
    },

    async append(projectId, messages) {
      for (const message of messages) {
        await db.query(
          `INSERT INTO chat_messages (project_id, role, content, tool_call_id, tool_name, tool_calls)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            projectId,
            message.role,
            message.content,
            message.toolCallId ?? null,
            message.name ?? null,
            message.toolCalls ? JSON.stringify(message.toolCalls) : null,
          ],
        );
      }
    },
  };
}
