import express, { type Express } from "express";
import type { ChatMessage, LLMClient } from "@app-builder/llm-client";
import { createInMemoryStore, type ChatSessionStore } from "./chatStore.js";

const SYSTEM_PROMPT =
  "You are the chat assistant for an app-builder tool that is still under " +
  "construction. App-generation capabilities are not wired in yet — for " +
  "now, just chat normally and be direct about what isn't built yet.";

export interface HealthInfo {
  baseUrl: string;
  model: string;
}

export function createApp(
  llmClient: LLMClient,
  healthInfo: HealthInfo,
  store: ChatSessionStore = createInMemoryStore(),
): Express {
  const app = express();
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      glm: { baseUrl: healthInfo.baseUrl, model: healthInfo.model },
    });
  });

  app.post("/api/chat", async (req, res) => {
    const { sessionId, message } = req.body ?? {};

    if (typeof sessionId !== "string" || sessionId.length === 0) {
      res
        .status(400)
        .json({ error: { code: "bad_request", message: "sessionId is required" } });
      return;
    }
    if (typeof message !== "string" || message.trim().length === 0) {
      res
        .status(400)
        .json({ error: { code: "bad_request", message: "message is required" } });
      return;
    }

    const history = store.get(sessionId);
    const userMessage: ChatMessage = { role: "user", content: message };

    try {
      const result = await llmClient.chat({
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history, userMessage],
      });
      store.append(sessionId, [userMessage, result.message]);
      res.json({ reply: result.message.content, finishReason: result.finishReason });
    } catch (error) {
      res.status(502).json({
        error: {
          code: "llm_error",
          message: error instanceof Error ? error.message : "Unknown LLM error",
        },
      });
    }
  });

  return app;
}
