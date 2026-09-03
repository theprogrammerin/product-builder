import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { ChatCompletionRequest, ChatCompletionResult, LLMClient } from "@app-builder/llm-client";
import type { RunAgent, StartResult } from "@app-builder/run-agent";
import {
  createApp,
  type CodegenOutcome,
  type DebugOutcome,
  type IntakeOutcome,
  type RunCodegenPhase,
  type RunDebugPhase,
  type RunIntakePhase,
  type RunOutcome,
  type Scaffold,
} from "../src/app.js";

function fakeLlmClient(reply = "hi there"): LLMClient & { chat: ReturnType<typeof vi.fn> } {
  const chat = vi.fn(
    async (_request: ChatCompletionRequest): Promise<ChatCompletionResult> => ({
      message: { role: "assistant", content: reply },
      finishReason: "stop",
    }),
  );
  return { chat };
}

function fakeScaffold(): Scaffold & ReturnType<typeof vi.fn> {
  return vi.fn(async (projectId: string) => `/fake/workspace/${projectId}`);
}

function fakeRunIntakePhase(outcome: IntakeOutcome): RunIntakePhase & ReturnType<typeof vi.fn> {
  return vi.fn(async () => outcome);
}

function fakeRunCodegenPhase(
  outcome: CodegenOutcome,
  progress: string[] = [],
  runOutcomes: RunOutcome[] = [],
): RunCodegenPhase & ReturnType<typeof vi.fn> {
  return vi.fn(async ({ onProgress, onRunOutcome }) => {
    for (const message of progress) onProgress(message);
    for (const runOutcome of runOutcomes) onRunOutcome(runOutcome);
    return outcome;
  });
}

function fakeRunDebugPhase(
  outcome: DebugOutcome,
  progress: string[] = [],
): RunDebugPhase & ReturnType<typeof vi.fn> {
  return vi.fn(async ({ onProgress }) => {
    for (const message of progress) onProgress(message);
    return outcome;
  });
}

function fakeRunAgent(overrides: Partial<RunAgent> = {}): RunAgent & {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  return {
    start: vi.fn(
      async (): Promise<StartResult> => ({
        status: "live",
        components: [{ name: "rails", port: 41000, url: "http://localhost:41000" }],
      }),
    ),
    stop: vi.fn(async () => {}),
    ...overrides,
  };
}

/** Lets the fire-and-forget build promise chain (including its chatStore.append calls) settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

const healthInfo = { baseUrl: "https://glm.example.com", model: "glm-4.6" };

describe("GET /api/health", () => {
  it("reports GLM config without leaking secrets", async () => {
    const app = createApp(fakeLlmClient(), healthInfo, undefined, undefined, fakeScaffold());
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
    const app = createApp(fakeLlmClient(), healthInfo, undefined, undefined, fakeScaffold());
    const response = await request(app).get("/api/projects");
    expect(response.status).toBe(200);
    expect(response.body.projects).toEqual([]);
  });

  it("creates a project defaulting to the ideation stage, with a scaffolded workspace", async () => {
    const scaffold = fakeScaffold();
    const app = createApp(fakeLlmClient(), healthInfo, undefined, undefined, scaffold);
    const response = await request(app).post("/api/projects").send({ name: "GearShare" });

    expect(response.status).toBe(201);
    expect(response.body.project).toMatchObject({ name: "GearShare", stage: "ideation" });
    expect(response.body.project.id).toEqual(expect.any(String));
    expect(response.body.project.workspacePath).toBe(`/fake/workspace/${response.body.project.id}`);
    expect(scaffold).toHaveBeenCalledWith(response.body.project.id);
  });

  it("rejects project creation with a missing name", async () => {
    const app = createApp(fakeLlmClient(), healthInfo, undefined, undefined, fakeScaffold());
    const response = await request(app).post("/api/projects").send({});
    expect(response.status).toBe(400);
  });

  it("fails project creation if scaffolding fails, without storing the project", async () => {
    const failingScaffold: Scaffold = vi.fn(async () => {
      throw new Error("disk full");
    });
    const app = createApp(fakeLlmClient(), healthInfo, undefined, undefined, failingScaffold);

    const response = await request(app).post("/api/projects").send({ name: "GearShare" });
    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe("scaffold_failed");

    const list = await request(app).get("/api/projects");
    expect(list.body.projects).toEqual([]);
  });

  it("updates a project's stage", async () => {
    const app = createApp(fakeLlmClient(), healthInfo, undefined, undefined, fakeScaffold());
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });
    const projectId = created.body.project.id;

    const response = await request(app)
      .patch(`/api/projects/${projectId}/stage`)
      .send({ stage: "ux" });

    expect(response.status).toBe(200);
    expect(response.body.project.stage).toBe("ux");
  });

  it("rejects an invalid stage", async () => {
    const app = createApp(fakeLlmClient(), healthInfo, undefined, undefined, fakeScaffold());
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });
    const response = await request(app)
      .patch(`/api/projects/${created.body.project.id}/stage`)
      .send({ stage: "not-a-real-stage" });
    expect(response.status).toBe(400);
  });

  it("404s when updating the stage of an unknown project", async () => {
    const app = createApp(fakeLlmClient(), healthInfo, undefined, undefined, fakeScaffold());
    const response = await request(app)
      .patch("/api/projects/does-not-exist/stage")
      .send({ stage: "ux" });
    expect(response.status).toBe(404);
  });
});

describe("POST /api/chat", () => {
  it("requires a projectId", async () => {
    const app = createApp(fakeLlmClient(), healthInfo, undefined, undefined, fakeScaffold());
    const response = await request(app).post("/api/chat").send({ message: "hi" });
    expect(response.status).toBe(400);
  });

  it("404s for an unknown projectId", async () => {
    const app = createApp(fakeLlmClient(), healthInfo, undefined, undefined, fakeScaffold());
    const response = await request(app)
      .post("/api/chat")
      .send({ projectId: "does-not-exist", message: "hi" });
    expect(response.status).toBe(404);
  });

  it("requires a non-empty message", async () => {
    const app = createApp(fakeLlmClient(), healthInfo, undefined, undefined, fakeScaffold());
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });
    const response = await request(app)
      .post("/api/chat")
      .send({ projectId: created.body.project.id, message: "  " });
    expect(response.status).toBe(400);
  });

  it("returns the LLM's reply for a valid project and message", async () => {
    const llmClient = fakeLlmClient("pong");
    const app = createApp(llmClient, healthInfo, undefined, undefined, fakeScaffold());
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });

    const response = await request(app)
      .post("/api/chat")
      .send({ projectId: created.body.project.id, message: "ping" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ reply: "pong", finishReason: "stop" });
  });

  it("carries prior turns as history on the next call for the same project", async () => {
    const llmClient = fakeLlmClient("second reply");
    const app = createApp(llmClient, healthInfo, undefined, undefined, fakeScaffold());
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

describe("POST /api/chat — /build (review phase)", () => {
  it("awaits the Intake phase and posts the plan as [build:review], without running Codegen", async () => {
    const runIntakePhase = fakeRunIntakePhase({
      kind: "spec",
      content: "## Resource\nTask\n\n## Fields\n- title: string\n\n## Screens\n### Task List\n...",
    });
    const runCodegenPhase = fakeRunCodegenPhase({ kind: "done", content: "should not run" });
    const app = createApp(
      fakeLlmClient(),
      healthInfo,
      undefined,
      undefined,
      fakeScaffold(),
      runIntakePhase,
      runCodegenPhase,
    );
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });
    const projectId = created.body.project.id;

    const response = await request(app)
      .post("/api/chat")
      .send({ projectId, message: "/build a task tracker with a title" });

    expect(response.status).toBe(200);
    expect(response.body.reply).toContain("[build:review] Proposed plan");
    expect(response.body.reply).toContain("## Resource\nTask");
    expect(runIntakePhase).toHaveBeenCalledWith(
      expect.objectContaining({ description: "a task tracker with a title" }),
    );
    expect(runCodegenPhase).not.toHaveBeenCalled();
  });

  it("posts the Intake Agent's clarifying question as [build:question], without storing a pending spec", async () => {
    const runIntakePhase = fakeRunIntakePhase({ kind: "question", content: "Which resource should I build first?" });
    const runCodegenPhase = fakeRunCodegenPhase({ kind: "done", content: "should not run" });
    const app = createApp(
      fakeLlmClient(),
      healthInfo,
      undefined,
      undefined,
      fakeScaffold(),
      runIntakePhase,
      runCodegenPhase,
    );
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });
    const projectId = created.body.project.id;

    await request(app).post("/api/chat").send({ projectId, message: "/build a list and its items" });
    const proceed = await request(app).post("/api/chat").send({ projectId, message: "/proceed" });

    expect(proceed.body.reply).toContain("Nothing is pending review");
    expect(runCodegenPhase).not.toHaveBeenCalled();
  });

  it("returns a 502 instead of crashing when the Intake phase throws (e.g. an upstream LLM error)", async () => {
    const runIntakePhase: RunIntakePhase = vi.fn(async () => {
      throw new Error("GLM request failed with status 402");
    });
    const app = createApp(fakeLlmClient(), healthInfo, undefined, undefined, fakeScaffold(), runIntakePhase);
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });
    const projectId = created.body.project.id;

    const response = await request(app)
      .post("/api/chat")
      .send({ projectId, message: "/build a task tracker" });

    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe("llm_error");

    // Ordinary chat still works afterward — the process didn't crash.
    const followUp = await request(app).post("/api/chat").send({ projectId, message: "hi" });
    expect(followUp.status).toBe(200);
  });

  it("rejects a /build with no description after the prefix, without invoking Intake", async () => {
    const runIntakePhase = fakeRunIntakePhase({ kind: "spec", content: "should not run" });
    const app = createApp(fakeLlmClient(), healthInfo, undefined, undefined, fakeScaffold(), runIntakePhase);
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });
    const projectId = created.body.project.id;

    const response = await request(app).post("/api/chat").send({ projectId, message: "/build" });

    expect(response.body.reply).toContain("Please describe what to build");
    expect(runIntakePhase).not.toHaveBeenCalled();
  });

  it("replaces a pending spec when a new /build is sent before /proceed", async () => {
    const runIntakePhase = vi
      .fn<RunIntakePhase>()
      .mockResolvedValueOnce({ kind: "spec", content: "## Resource\nFirst\n" })
      .mockResolvedValueOnce({ kind: "spec", content: "## Resource\nSecond\n" });
    const runCodegenPhase = fakeRunCodegenPhase({ kind: "done", content: "done" });
    const app = createApp(
      fakeLlmClient(),
      healthInfo,
      undefined,
      undefined,
      fakeScaffold(),
      runIntakePhase,
      runCodegenPhase,
    );
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });
    const projectId = created.body.project.id;

    await request(app).post("/api/chat").send({ projectId, message: "/build first idea" });
    await request(app).post("/api/chat").send({ projectId, message: "/build second idea" });
    await request(app).post("/api/chat").send({ projectId, message: "/proceed" });
    await flush();

    expect(runCodegenPhase).toHaveBeenCalledWith(
      expect.objectContaining({ buildSpec: "## Resource\nSecond\n" }),
    );
  });

  it("does not affect ordinary chat messages that don't start with /build", async () => {
    const runIntakePhase = fakeRunIntakePhase({ kind: "spec", content: "should not run" });
    const llmClient = fakeLlmClient("just chatting");
    const app = createApp(llmClient, healthInfo, undefined, undefined, fakeScaffold(), runIntakePhase);
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });
    const projectId = created.body.project.id;

    const response = await request(app)
      .post("/api/chat")
      .send({ projectId, message: "how does /build work?" });

    expect(response.body.reply).toBe("just chatting");
    expect(runIntakePhase).not.toHaveBeenCalled();
  });
});

describe("POST /api/chat — /proceed (build phase)", () => {
  async function setUpPendingSpec(
    app: ReturnType<typeof createApp>,
    projectId: string,
    spec = "## Resource\nTask\n\n## Fields\n- title: string\n",
  ) {
    // Uses whatever runIntakePhase the app was built with — tests below
    // configure it to return this spec.
    await request(app).post("/api/chat").send({ projectId, message: `/build ${spec}` });
  }

  it("runs the Codegen phase against the reviewed spec, posting interim and result messages", async () => {
    const spec = "## Resource\nTask\n\n## Fields\n- title: string\n";
    const runIntakePhase = fakeRunIntakePhase({ kind: "spec", content: spec });
    const runCodegenPhase = fakeRunCodegenPhase(
      { kind: "done", content: "Build complete — backend: 19 examples, 0 failures; frontend: Tests: 3 passed, 3 total" },
      ["Backend complete — 19 examples, 0 failures. Starting the frontend...", "Wiring navigation..."],
    );
    const app = createApp(
      fakeLlmClient(),
      healthInfo,
      undefined,
      undefined,
      fakeScaffold(),
      runIntakePhase,
      runCodegenPhase,
    );
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });
    const projectId = created.body.project.id;

    await setUpPendingSpec(app, projectId, spec);
    const response = await request(app).post("/api/chat").send({ projectId, message: "/proceed" });

    expect(response.body.reply).toBe("[build] Got it — starting the build. This can take several minutes.");
    expect(runCodegenPhase).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: `/fake/workspace/${projectId}`, buildSpec: spec }),
    );

    await flush();

    const history = await request(app).get(`/api/projects/${projectId}/messages`);
    const contents = history.body.messages.map((m: { content: string }) => m.content);
    expect(contents).toEqual([
      `/build ${spec}`,
      expect.stringContaining("[build:review]"),
      "/proceed",
      "[build] Got it — starting the build. This can take several minutes.",
      "[build] Backend complete — 19 examples, 0 failures. Starting the frontend...",
      "[build] Wiring navigation...",
      "[build:done] Build complete — backend: 19 examples, 0 failures; frontend: Tests: 3 passed, 3 total",
    ]);
  });

  it("tags a failed build outcome as [build:failed]", async () => {
    const runIntakePhase = fakeRunIntakePhase({ kind: "spec", content: "## Resource\nTask\n" });
    const runCodegenPhase = fakeRunCodegenPhase({ kind: "failed", content: "Frontend tests did not pass" });
    const app = createApp(
      fakeLlmClient(),
      healthInfo,
      undefined,
      undefined,
      fakeScaffold(),
      runIntakePhase,
      runCodegenPhase,
    );
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });
    const projectId = created.body.project.id;

    await setUpPendingSpec(app, projectId);
    await request(app).post("/api/chat").send({ projectId, message: "/proceed" });
    await flush();

    const history = await request(app).get(`/api/projects/${projectId}/messages`);
    expect(history.body.messages.at(-1).content).toBe("[build:failed] Frontend tests did not pass");
  });

  it("catches a thrown error from the Codegen phase and reports it as [build:failed]", async () => {
    const runIntakePhase = fakeRunIntakePhase({ kind: "spec", content: "## Resource\nTask\n" });
    const runCodegenPhase: RunCodegenPhase = vi.fn(async () => {
      throw new Error("docker daemon not running");
    });
    const app = createApp(
      fakeLlmClient(),
      healthInfo,
      undefined,
      undefined,
      fakeScaffold(),
      runIntakePhase,
      runCodegenPhase,
    );
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });
    const projectId = created.body.project.id;

    await setUpPendingSpec(app, projectId);
    await request(app).post("/api/chat").send({ projectId, message: "/proceed" });
    await flush();

    const history = await request(app).get(`/api/projects/${projectId}/messages`);
    expect(history.body.messages.at(-1).content).toBe(
      "[build:failed] Unexpected error: docker daemon not running",
    );
  });

  it("replies that nothing is pending when /proceed is sent with no prior /build", async () => {
    const app = createApp(fakeLlmClient(), healthInfo, undefined, undefined, fakeScaffold());
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });
    const projectId = created.body.project.id;

    const response = await request(app).post("/api/chat").send({ projectId, message: "/proceed" });

    expect(response.body.reply).toContain("Nothing is pending review");
  });

  it("rejects a second /proceed while a build is already running, without double-building", async () => {
    const runIntakePhase = fakeRunIntakePhase({ kind: "spec", content: "## Resource\nTask\n" });
    let resolveFirst!: (outcome: CodegenOutcome) => void;
    const runCodegenPhase: RunCodegenPhase = vi.fn(
      () => new Promise<CodegenOutcome>((resolve) => (resolveFirst = resolve)),
    );
    const app = createApp(
      fakeLlmClient(),
      healthInfo,
      undefined,
      undefined,
      fakeScaffold(),
      runIntakePhase,
      runCodegenPhase,
    );
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });
    const projectId = created.body.project.id;

    await setUpPendingSpec(app, projectId);
    await request(app).post("/api/chat").send({ projectId, message: "/proceed" });
    const second = await request(app).post("/api/chat").send({ projectId, message: "/proceed" });

    expect(second.body.reply).toContain("already running");
    expect(runCodegenPhase).toHaveBeenCalledTimes(1);

    resolveFirst({ kind: "done", content: "done" });
    await flush();
  });

  it("rejects /build for the same project while a build is already running", async () => {
    const runIntakePhase = fakeRunIntakePhase({ kind: "spec", content: "## Resource\nTask\n" });
    let resolveFirst!: (outcome: CodegenOutcome) => void;
    const runCodegenPhase: RunCodegenPhase = vi.fn(
      () => new Promise<CodegenOutcome>((resolve) => (resolveFirst = resolve)),
    );
    const app = createApp(
      fakeLlmClient(),
      healthInfo,
      undefined,
      undefined,
      fakeScaffold(),
      runIntakePhase,
      runCodegenPhase,
    );
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });
    const projectId = created.body.project.id;

    await setUpPendingSpec(app, projectId);
    await request(app).post("/api/chat").send({ projectId, message: "/proceed" });
    const secondBuild = await request(app).post("/api/chat").send({ projectId, message: "/build something else" });

    expect(secondBuild.body.reply).toContain("already running");
    expect(runIntakePhase).toHaveBeenCalledTimes(1);

    resolveFirst({ kind: "done", content: "done" });
    await flush();
  });

  it("posts [run:pending] then [run:live] as the Codegen phase reports them, independently of the build outcome", async () => {
    const runIntakePhase = fakeRunIntakePhase({ kind: "spec", content: "## Resource\nTask\n" });
    const runCodegenPhase = fakeRunCodegenPhase(
      { kind: "done", content: "Build complete" },
      [],
      [
        { kind: "pending" },
        { kind: "live", components: [{ name: "rails", port: 41000, url: "http://localhost:41000" }] },
      ],
    );
    const app = createApp(
      fakeLlmClient(),
      healthInfo,
      undefined,
      undefined,
      fakeScaffold(),
      runIntakePhase,
      runCodegenPhase,
    );
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });
    const projectId = created.body.project.id;

    await setUpPendingSpec(app, projectId);
    await request(app).post("/api/chat").send({ projectId, message: "/proceed" });
    await flush();

    const history = await request(app).get(`/api/projects/${projectId}/messages`);
    const contents = history.body.messages.map((m: { content: string }) => m.content);
    expect(contents).toContain("[run] Starting your app...");
    expect(contents).toContain("[run:live] Your app is running — rails: http://localhost:41000");

    // Confirmed via runStore, not just the chat log — /run should now
    // report "already running" instead of starting a fresh one.
    const runAgain = await request(app).post("/api/chat").send({ projectId, message: "/run" });
    expect(runAgain.body.reply).toBe("[run:live] Already running — rails: http://localhost:41000");
  });

  it("reports a [run:failed] outcome without affecting the [build:...] outcome", async () => {
    const runIntakePhase = fakeRunIntakePhase({ kind: "spec", content: "## Resource\nTask\n" });
    const runCodegenPhase = fakeRunCodegenPhase(
      { kind: "done", content: "Build complete" },
      [],
      [{ kind: "pending" }, { kind: "failed", error: "docker compose up failed: port in use" }],
    );
    const app = createApp(
      fakeLlmClient(),
      healthInfo,
      undefined,
      undefined,
      fakeScaffold(),
      runIntakePhase,
      runCodegenPhase,
    );
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });
    const projectId = created.body.project.id;

    await setUpPendingSpec(app, projectId);
    await request(app).post("/api/chat").send({ projectId, message: "/proceed" });
    await flush();

    const history = await request(app).get(`/api/projects/${projectId}/messages`);
    const contents = history.body.messages.map((m: { content: string }) => m.content);
    expect(contents).toContain("[run:failed] docker compose up failed: port in use");
    expect(contents).toContain("[build:done] Build complete");
  });
});

describe("POST /api/chat — /run", () => {
  it("starts the app and reports the live component URLs", async () => {
    const runAgent = fakeRunAgent();
    const app = createApp(
      fakeLlmClient(),
      healthInfo,
      undefined,
      undefined,
      fakeScaffold(),
      undefined,
      undefined,
      undefined,
      runAgent,
    );
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });
    const projectId = created.body.project.id;

    const ack = await request(app).post("/api/chat").send({ projectId, message: "/run" });
    expect(ack.body.reply).toBe("[run] Starting your app...");
    await flush();

    expect(runAgent.start).toHaveBeenCalledWith({ workspacePath: `/fake/workspace/${projectId}` });
    const history = await request(app).get(`/api/projects/${projectId}/messages`);
    expect(history.body.messages.at(-1).content).toBe(
      "[run:live] Your app is running — rails: http://localhost:41000",
    );
  });

  it("reports already-live status without starting a second instance", async () => {
    const runAgent = fakeRunAgent();
    const app = createApp(
      fakeLlmClient(),
      healthInfo,
      undefined,
      undefined,
      fakeScaffold(),
      undefined,
      undefined,
      undefined,
      runAgent,
    );
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });
    const projectId = created.body.project.id;

    await request(app).post("/api/chat").send({ projectId, message: "/run" });
    await flush();
    const second = await request(app).post("/api/chat").send({ projectId, message: "/run" });

    expect(second.body.reply).toBe("[run:live] Already running — rails: http://localhost:41000");
    expect(runAgent.start).toHaveBeenCalledTimes(1);
  });

  it("reports a failure from the Run Agent as [run:failed]", async () => {
    const runAgent = fakeRunAgent({
      start: vi.fn(async (): Promise<StartResult> => ({ status: "failed", components: [], error: "port in use" })),
    });
    const app = createApp(
      fakeLlmClient(),
      healthInfo,
      undefined,
      undefined,
      fakeScaffold(),
      undefined,
      undefined,
      undefined,
      runAgent,
    );
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });
    const projectId = created.body.project.id;

    await request(app).post("/api/chat").send({ projectId, message: "/run" });
    await flush();

    const history = await request(app).get(`/api/projects/${projectId}/messages`);
    expect(history.body.messages.at(-1).content).toBe("[run:failed] port in use");
  });

  it("declines to start while a build is in progress for the same project", async () => {
    const runIntakePhase = fakeRunIntakePhase({ kind: "spec", content: "## Resource\nTask\n" });
    let resolveFirst!: (outcome: CodegenOutcome) => void;
    const runCodegenPhase: RunCodegenPhase = vi.fn(
      () => new Promise<CodegenOutcome>((resolve) => (resolveFirst = resolve)),
    );
    const runAgent = fakeRunAgent();
    const app = createApp(
      fakeLlmClient(),
      healthInfo,
      undefined,
      undefined,
      fakeScaffold(),
      runIntakePhase,
      runCodegenPhase,
      undefined,
      runAgent,
    );
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });
    const projectId = created.body.project.id;

    await request(app).post("/api/chat").send({ projectId, message: `/build ## Resource\nTask\n` });
    await request(app).post("/api/chat").send({ projectId, message: "/proceed" });

    const response = await request(app).post("/api/chat").send({ projectId, message: "/run" });
    expect(response.body.reply).toContain("build is in progress");
    expect(runAgent.start).not.toHaveBeenCalled();

    resolveFirst({ kind: "done", content: "done" });
    await flush();
  });
});

describe("POST /api/chat — /stop", () => {
  it("stops a live instance", async () => {
    const runAgent = fakeRunAgent();
    const app = createApp(
      fakeLlmClient(),
      healthInfo,
      undefined,
      undefined,
      fakeScaffold(),
      undefined,
      undefined,
      undefined,
      runAgent,
    );
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });
    const projectId = created.body.project.id;

    await request(app).post("/api/chat").send({ projectId, message: "/run" });
    await flush();

    const response = await request(app).post("/api/chat").send({ projectId, message: "/stop" });

    expect(response.body.reply).toBe("[stop:done] Stopped — your data and code are untouched.");
    expect(runAgent.stop).toHaveBeenCalledWith({ workspacePath: `/fake/workspace/${projectId}` });

    // Confirmed via runStore, not just the reply: a follow-up /run treats
    // it as stopped, not still live.
    const runAfterStop = await request(app).post("/api/chat").send({ projectId, message: "/run" });
    expect(runAfterStop.body.reply).toBe("[run] Starting your app...");
  });

  it("reports nothing running when nothing has ever been started", async () => {
    const app = createApp(fakeLlmClient(), healthInfo, undefined, undefined, fakeScaffold());
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });
    const projectId = created.body.project.id;

    const response = await request(app).post("/api/chat").send({ projectId, message: "/stop" });
    expect(response.body.reply).toBe("Nothing is running for this project.");
  });
});

describe("POST /api/chat — /debug", () => {
  it("investigates a described problem and reports [debug:done]", async () => {
    const runDebugPhase = fakeRunDebugPhase(
      { kind: "done", content: "Debug complete — Backend: 20 examples, 0 failures; Frontend: Tests: 5 passed, 5 total" },
      ["Found it — a missing null check in TaskEditScreen."],
    );
    const app = createApp(
      fakeLlmClient(),
      healthInfo,
      undefined,
      undefined,
      fakeScaffold(),
      undefined,
      undefined,
      undefined,
      undefined,
      runDebugPhase,
    );
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });
    const projectId = created.body.project.id;

    const ack = await request(app).post("/api/chat").send({ projectId, message: "/debug the login screen crashes" });
    expect(ack.body.reply).toBe("[debug] Got it — looking into this. This can take a few minutes.");
    await flush();

    expect(runDebugPhase).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: `/fake/workspace/${projectId}`,
        description: "the login screen crashes",
      }),
    );

    const history = await request(app).get(`/api/projects/${projectId}/messages`);
    const contents = history.body.messages.map((m: { content: string }) => m.content);
    expect(contents).toEqual([
      "/debug the login screen crashes",
      "[debug] Got it — looking into this. This can take a few minutes.",
      "[debug] Found it — a missing null check in TaskEditScreen.",
      "[debug:done] Debug complete — Backend: 20 examples, 0 failures; Frontend: Tests: 5 passed, 5 total",
    ]);
  });

  it("passes undefined as the description for a general sweep with no description", async () => {
    const runDebugPhase = fakeRunDebugPhase({ kind: "done", content: "Debug complete — nothing was wrong" });
    const app = createApp(
      fakeLlmClient(),
      healthInfo,
      undefined,
      undefined,
      fakeScaffold(),
      undefined,
      undefined,
      undefined,
      undefined,
      runDebugPhase,
    );
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });
    const projectId = created.body.project.id;

    await request(app).post("/api/chat").send({ projectId, message: "/debug" });
    await flush();

    expect(runDebugPhase).toHaveBeenCalledWith(expect.objectContaining({ description: undefined }));
  });

  it("passes the project's live component list through when the Run Agent has it running", async () => {
    const runAgent = fakeRunAgent();
    const runDebugPhase = fakeRunDebugPhase({ kind: "done", content: "Debug complete" });
    const app = createApp(
      fakeLlmClient(),
      healthInfo,
      undefined,
      undefined,
      fakeScaffold(),
      undefined,
      undefined,
      undefined,
      runAgent,
      runDebugPhase,
    );
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });
    const projectId = created.body.project.id;

    await request(app).post("/api/chat").send({ projectId, message: "/run" });
    await flush();

    await request(app).post("/api/chat").send({ projectId, message: "/debug" });
    await flush();

    expect(runDebugPhase).toHaveBeenCalledWith(
      expect.objectContaining({
        liveComponents: [{ name: "rails", port: 41000, url: "http://localhost:41000" }],
      }),
    );
  });

  it("does not pass a live component list when nothing is running", async () => {
    const runDebugPhase = fakeRunDebugPhase({ kind: "done", content: "Debug complete" });
    const app = createApp(
      fakeLlmClient(),
      healthInfo,
      undefined,
      undefined,
      fakeScaffold(),
      undefined,
      undefined,
      undefined,
      undefined,
      runDebugPhase,
    );
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });
    const projectId = created.body.project.id;

    await request(app).post("/api/chat").send({ projectId, message: "/debug" });
    await flush();

    expect(runDebugPhase).toHaveBeenCalledWith(expect.objectContaining({ liveComponents: undefined }));
  });

  it("tags a still-failing outcome as [debug:failed]", async () => {
    const runDebugPhase = fakeRunDebugPhase({ kind: "failed", content: "Investigated, but tests still don't fully pass" });
    const app = createApp(
      fakeLlmClient(),
      healthInfo,
      undefined,
      undefined,
      fakeScaffold(),
      undefined,
      undefined,
      undefined,
      undefined,
      runDebugPhase,
    );
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });
    const projectId = created.body.project.id;

    await request(app).post("/api/chat").send({ projectId, message: "/debug something" });
    await flush();

    const history = await request(app).get(`/api/projects/${projectId}/messages`);
    expect(history.body.messages.at(-1).content).toBe(
      "[debug:failed] Investigated, but tests still don't fully pass",
    );
  });

  it("catches a thrown error from the Debug phase and reports it as [debug:failed]", async () => {
    const runDebugPhase: RunDebugPhase = vi.fn(async () => {
      throw new Error("docker daemon not running");
    });
    const app = createApp(
      fakeLlmClient(),
      healthInfo,
      undefined,
      undefined,
      fakeScaffold(),
      undefined,
      undefined,
      undefined,
      undefined,
      runDebugPhase,
    );
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });
    const projectId = created.body.project.id;

    await request(app).post("/api/chat").send({ projectId, message: "/debug something" });
    await flush();

    const history = await request(app).get(`/api/projects/${projectId}/messages`);
    expect(history.body.messages.at(-1).content).toBe(
      "[debug:failed] Unexpected error: docker daemon not running",
    );
  });

  it("declines to start while a build is in progress for the same project", async () => {
    const runIntakePhase = fakeRunIntakePhase({ kind: "spec", content: "## Resource\nTask\n" });
    let resolveFirst!: (outcome: CodegenOutcome) => void;
    const runCodegenPhase: RunCodegenPhase = vi.fn(
      () => new Promise<CodegenOutcome>((resolve) => (resolveFirst = resolve)),
    );
    const runDebugPhase = fakeRunDebugPhase({ kind: "done", content: "should not run" });
    const app = createApp(
      fakeLlmClient(),
      healthInfo,
      undefined,
      undefined,
      fakeScaffold(),
      runIntakePhase,
      runCodegenPhase,
      undefined,
      undefined,
      runDebugPhase,
    );
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });
    const projectId = created.body.project.id;

    await request(app).post("/api/chat").send({ projectId, message: "/build a task tracker" });
    await request(app).post("/api/chat").send({ projectId, message: "/proceed" });

    const response = await request(app).post("/api/chat").send({ projectId, message: "/debug something" });
    expect(response.body.reply).toContain("Already working on this project");
    expect(runDebugPhase).not.toHaveBeenCalled();

    resolveFirst({ kind: "done", content: "done" });
    await flush();
  });

  it("declines to start a second /debug while one is already running", async () => {
    let resolveFirst!: (outcome: DebugOutcome) => void;
    const runDebugPhase: RunDebugPhase = vi.fn(
      () => new Promise<DebugOutcome>((resolve) => (resolveFirst = resolve)),
    );
    const app = createApp(
      fakeLlmClient(),
      healthInfo,
      undefined,
      undefined,
      fakeScaffold(),
      undefined,
      undefined,
      undefined,
      undefined,
      runDebugPhase,
    );
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });
    const projectId = created.body.project.id;

    await request(app).post("/api/chat").send({ projectId, message: "/debug first" });
    const second = await request(app).post("/api/chat").send({ projectId, message: "/debug second" });

    expect(second.body.reply).toContain("Already working on this project");
    expect(runDebugPhase).toHaveBeenCalledTimes(1);

    resolveFirst({ kind: "done", content: "done" });
    await flush();
  });
});
