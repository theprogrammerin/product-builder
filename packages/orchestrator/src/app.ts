import express, { type Express } from "express";
import type { ChatMessage, LLMClient } from "@app-builder/llm-client";
import { createInMemoryStore, type ChatSessionStore } from "./chatStore.js";
import {
  createInMemoryProjectStore,
  isProjectStage,
  type ProjectStore,
} from "./projectStore.js";

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
  chatStore: ChatSessionStore = createInMemoryStore(),
  projectStore: ProjectStore = createInMemoryProjectStore(),
): Express {
  const app = express();
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      glm: { baseUrl: healthInfo.baseUrl, model: healthInfo.model },
    });
  });

  app.get("/api/projects", (_req, res) => {
    res.json({ projects: projectStore.list() });
  });

  app.post("/api/projects", (req, res) => {
    const { name } = req.body ?? {};
    if (typeof name !== "string" || name.trim().length === 0) {
      res
        .status(400)
        .json({ error: { code: "bad_request", message: "name is required" } });
      return;
    }
    const project = projectStore.create(name.trim());
    res.status(201).json({ project });
  });

  app.patch("/api/projects/:id/stage", (req, res) => {
    const { stage } = req.body ?? {};
    if (!isProjectStage(stage)) {
      res
        .status(400)
        .json({ error: { code: "bad_request", message: "stage is invalid" } });
      return;
    }
    const project = projectStore.updateStage(req.params.id, stage);
    if (!project) {
      res
        .status(404)
        .json({ error: { code: "not_found", message: "project not found" } });
      return;
    }
    res.json({ project });
  });

  app.post("/api/chat", async (req, res) => {
    const { projectId, message } = req.body ?? {};

    if (typeof projectId !== "string" || projectId.length === 0) {
      res
        .status(400)
        .json({ error: { code: "bad_request", message: "projectId is required" } });
      return;
    }
    if (!projectStore.get(projectId)) {
      res
        .status(404)
        .json({ error: { code: "not_found", message: "project not found" } });
      return;
    }
    if (typeof message !== "string" || message.trim().length === 0) {
      res
        .status(400)
        .json({ error: { code: "bad_request", message: "message is required" } });
      return;
    }

    const history = chatStore.get(projectId);
    const userMessage: ChatMessage = { role: "user", content: message };

    try {
      const result = await llmClient.chat({
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history, userMessage],
      });
      chatStore.append(projectId, [userMessage, result.message]);
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
