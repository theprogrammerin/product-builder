import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { ChatCompletionRequest, ChatCompletionResult, LLMClient } from "@app-builder/llm-client";
import { createApp } from "../src/app.js";

function fakeLlmClient(reply = "hi there"): LLMClient & { chat: ReturnType<typeof vi.fn> } {
  const chat = vi.fn(
    async (_request: ChatCompletionRequest): Promise<ChatCompletionResult> => ({
      message: { role: "assistant", content: reply },
      finishReason: "stop",
    }),
  );
  return { chat };
}

const healthInfo = { baseUrl: "https://glm.example.com", model: "glm-4.6" };

describe("GET /api/health", () => {
  it("reports GLM config without leaking secrets", async () => {
    const app = createApp(fakeLlmClient(), healthInfo);
    const response = await request(app).get("/api/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ok",
      glm: { baseUrl: "https://glm.example.com", model: "glm-4.6" },
    });
  });
});

describe("project endpoints", () => {
  it("starts with an empty project list", async () => {
    const app = createApp(fakeLlmClient(), healthInfo);
    const response = await request(app).get("/api/projects");
    expect(response.status).toBe(200);
    expect(response.body.projects).toEqual([]);
  });

  it("creates a project defaulting to the ideation stage", async () => {
    const app = createApp(fakeLlmClient(), healthInfo);
    const response = await request(app).post("/api/projects").send({ name: "GearShare" });
    expect(response.status).toBe(201);
    expect(response.body.project).toMatchObject({ name: "GearShare", stage: "ideation" });
    expect(response.body.project.id).toEqual(expect.any(String));
  });

  it("rejects project creation with a missing name", async () => {
    const app = createApp(fakeLlmClient(), healthInfo);
    const response = await request(app).post("/api/projects").send({});
    expect(response.status).toBe(400);
  });

  it("updates a project's stage", async () => {
    const app = createApp(fakeLlmClient(), healthInfo);
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });
    const projectId = created.body.project.id;

    const response = await request(app)
      .patch(`/api/projects/${projectId}/stage`)
      .send({ stage: "ux" });

    expect(response.status).toBe(200);
    expect(response.body.project.stage).toBe("ux");
  });

  it("rejects an invalid stage", async () => {
    const app = createApp(fakeLlmClient(), healthInfo);
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });
    const response = await request(app)
      .patch(`/api/projects/${created.body.project.id}/stage`)
      .send({ stage: "not-a-real-stage" });
    expect(response.status).toBe(400);
  });

  it("404s when updating the stage of an unknown project", async () => {
    const app = createApp(fakeLlmClient(), healthInfo);
    const response = await request(app)
      .patch("/api/projects/does-not-exist/stage")
      .send({ stage: "ux" });
    expect(response.status).toBe(404);
  });
});

describe("POST /api/chat", () => {
  it("requires a projectId", async () => {
    const app = createApp(fakeLlmClient(), healthInfo);
    const response = await request(app).post("/api/chat").send({ message: "hi" });
    expect(response.status).toBe(400);
  });

  it("404s for an unknown projectId", async () => {
    const app = createApp(fakeLlmClient(), healthInfo);
    const response = await request(app)
      .post("/api/chat")
      .send({ projectId: "does-not-exist", message: "hi" });
    expect(response.status).toBe(404);
  });

  it("requires a non-empty message", async () => {
    const app = createApp(fakeLlmClient(), healthInfo);
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });
    const response = await request(app)
      .post("/api/chat")
      .send({ projectId: created.body.project.id, message: "  " });
    expect(response.status).toBe(400);
  });

  it("returns the LLM's reply for a valid project and message", async () => {
    const llmClient = fakeLlmClient("pong");
    const app = createApp(llmClient, healthInfo);
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });

    const response = await request(app)
      .post("/api/chat")
      .send({ projectId: created.body.project.id, message: "ping" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ reply: "pong", finishReason: "stop" });
  });

  it("carries prior turns as history on the next call for the same project", async () => {
    const llmClient = fakeLlmClient("second reply");
    const app = createApp(llmClient, healthInfo);
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });
    const projectId = created.body.project.id;

    await request(app).post("/api/chat").send({ projectId, message: "first message" });
    await request(app).post("/api/chat").send({ projectId, message: "second message" });

    const secondCallArgs = llmClient.chat.mock.calls[1][0] as ChatCompletionRequest;
    expect(secondCallArgs.messages.map((m) => m.content)).toEqual([
      expect.stringContaining("app-builder"),
      "first message",
      "second reply",
      "second message",
    ]);
  });
});
