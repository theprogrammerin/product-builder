import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { ChatCompletionRequest, ChatCompletionResult, LLMClient, Usage } from "@app-builder/llm-client";
import type { RunAgent, StartResult } from "@app-builder/run-agent";
import {
  createApp,
  defaultRunIntakePhase,
  deriveFeatureSlug,
  filterHistoryForIntake,
  formatEmptyTurn,
  formatToolCall,
  isNoisyProgressMessage,
  readExistingProjectContext,
  slugify,
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

function fakeRunIntakePhase(
  outcome: IntakeOutcome,
  usages: Usage[] = [],
): RunIntakePhase & ReturnType<typeof vi.fn> {
  return vi.fn(async ({ onCallStart, onUsage }) => {
    for (const usage of usages) {
      onCallStart();
      onUsage(usage);
    }
    return outcome;
  });
}

function fakeRunCodegenPhase(
  outcome: CodegenOutcome,
  progress: string[] = [],
  runOutcomes: RunOutcome[] = [],
  usages: Usage[] = [],
): RunCodegenPhase & ReturnType<typeof vi.fn> {
  return vi.fn(async ({ onProgress, onRunOutcome, onCallStart, onUsage }) => {
    for (const message of progress) onProgress(message);
    for (const runOutcome of runOutcomes) onRunOutcome(runOutcome);
    for (const usage of usages) {
      onCallStart();
      onUsage(usage);
    }
    return outcome;
  });
}

function fakeRunDebugPhase(
  outcome: DebugOutcome,
  progress: string[] = [],
  usages: Usage[] = [],
): RunDebugPhase & ReturnType<typeof vi.fn> {
  return vi.fn(async ({ onProgress, onCallStart, onUsage }) => {
    for (const message of progress) onProgress(message);
    for (const usage of usages) {
      onCallStart();
      onUsage(usage);
    }
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

describe("formatToolCall", () => {
  it("summarizes a path-based tool call", () => {
    expect(formatToolCall("write_file", { path: "app/models/note.rb", content: "..." })).toBe(
      "→ write_file: app/models/note.rb",
    );
    expect(formatToolCall("read_file", { path: "app/models/note.rb" })).toBe("→ read_file: app/models/note.rb");
    expect(formatToolCall("list_dir", { path: "app" })).toBe("→ list_dir: app");
    expect(formatToolCall("list_files", { path: "app" })).toBe("→ list_files: app");
  });

  it("summarizes the project-doc tools with their path too", () => {
    expect(formatToolCall("read_project_doc", { path: "docs/backlog.md" })).toBe("→ read_project_doc: docs/backlog.md");
    expect(formatToolCall("write_project_doc", { path: "docs/designs/x.md", content: "..." })).toBe(
      "→ write_project_doc: docs/designs/x.md",
    );
  });

  it("summarizes search_files with its pattern", () => {
    expect(formatToolCall("search_files", { pattern: "CORS", path: "app" })).toBe('→ search_files: "CORS"');
  });

  it("summarizes run_command with the actual command", () => {
    expect(formatToolCall("run_command", { command: "bundle exec rspec" })).toBe("→ run_command: bundle exec rspec");
  });

  it("falls back to just the tool name when the expected arg is missing or the tool is unknown", () => {
    expect(formatToolCall("write_file", {})).toBe("→ write_file");
    expect(formatToolCall("run_command", {})).toBe("→ run_command");
    expect(formatToolCall("some_future_tool", { foo: "bar" })).toBe("→ some_future_tool");
    expect(formatToolCall("list_files", undefined)).toBe("→ list_files");
  });
});

describe("formatEmptyTurn", () => {
  it("names the token budget explicitly when finishReason is length", () => {
    expect(formatEmptyTurn("length")).toBe("→ empty turn — ran out of token budget, nudging model to continue");
  });

  it("names the actual finishReason otherwise, for diagnosability", () => {
    expect(formatEmptyTurn("stop")).toBe("→ empty turn (finishReason: stop) — nudging model to continue");
    expect(formatEmptyTurn("content_filter")).toBe(
      "→ empty turn (finishReason: content_filter) — nudging model to continue",
    );
  });
});

describe("defaultRunIntakePhase", () => {
  it("reports usage via onUsage and returns the reply content unchanged", async () => {
    const chat = vi.fn(
      async (_request: ChatCompletionRequest): Promise<ChatCompletionResult> => ({
        message: { role: "assistant", content: "## Resource\nTask\n" },
        finishReason: "stop",
        usage: { promptTokens: 100, completionTokens: 40, totalTokens: 140 },
      }),
    );
    const onCallStart = vi.fn();
    const onUsage = vi.fn();

    const result = await defaultRunIntakePhase({
      description: "a task tracker",
      llmClient: { chat },
      onCallStart,
      onUsage,
    });

    expect(result.content).toBe("## Resource\nTask");
    expect(onCallStart).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith({ promptTokens: 100, completionTokens: 40, totalTokens: 140 });
  });

  it("does not call onUsage when the result has no usage", async () => {
    const chat = vi.fn(
      async (_request: ChatCompletionRequest): Promise<ChatCompletionResult> => ({
        message: { role: "assistant", content: "## Resource\nTask\n" },
        finishReason: "stop",
      }),
    );
    const onUsage = vi.fn();

    const result = await defaultRunIntakePhase({
      description: "a task tracker",
      llmClient: { chat },
      onCallStart: vi.fn(),
      onUsage,
    });

    expect(result.content).toBe("## Resource\nTask");
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("uses the incremental system prompt (with the existing-state context) when existingContext is supplied", async () => {
    const chat = vi.fn(
      async (_request: ChatCompletionRequest): Promise<ChatCompletionResult> => ({
        message: { role: "assistant", content: "## Resource\nReminder\n" },
        finishReason: "stop",
      }),
    );

    await defaultRunIntakePhase({
      description: "add reminders",
      llmClient: { chat },
      existingContext: {
        features: "## Current state\n\nA Task resource.",
        architecture: "Rails + Expo.",
        backlog: "| 1 | Initial build | done | | |",
      },
      onCallStart: vi.fn(),
      onUsage: vi.fn(),
    });

    const systemPrompt = chat.mock.calls[0][0].messages[0].content as string;
    expect(systemPrompt.toLowerCase()).toContain("already has real work in it");
    expect(systemPrompt).toContain("A Task resource.");
  });
});

describe("GET /api/projects/:id/progress", () => {
  it("returns null when nothing has run for the project yet", async () => {
    const app = createApp(fakeLlmClient(), healthInfo, undefined, undefined, fakeScaffold());
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });

    const response = await request(app).get(`/api/projects/${created.body.project.id}/progress`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ progress: null });
  });

  it("404s for an unknown project", async () => {
    const app = createApp(fakeLlmClient(), healthInfo, undefined, undefined, fakeScaffold());
    const response = await request(app).get("/api/projects/does-not-exist/progress");
    expect(response.status).toBe(404);
  });

  it("accumulates token totals across multiple LLM calls during /proceed, clearing callStartedAt once done", async () => {
    const spec = "## Resource\nTask\n";
    const runIntakePhase = fakeRunIntakePhase({ kind: "spec", content: spec });
    const runCodegenPhase = fakeRunCodegenPhase(
      { kind: "done", content: "Build complete" },
      [],
      [],
      [
        { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
        { promptTokens: 150, completionTokens: 30, totalTokens: 180 },
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

    await request(app).post("/api/chat").send({ projectId, message: `/build ${spec}` });
    await request(app).post("/api/chat").send({ projectId, message: "/proceed" });
    await flush();

    const response = await request(app).get(`/api/projects/${projectId}/progress`);

    expect(response.body).toEqual({
      progress: {
        agentLabel: "Codegen Agent",
        totalSentTokens: 250,
        totalReceivedTokens: 50,
        callStartedAt: null,
      },
    });
  });

  it("reports a non-null callStartedAt while a call is in flight", async () => {
    const spec = "## Resource\nTask\n";
    const runIntakePhase = fakeRunIntakePhase({ kind: "spec", content: spec });
    let resolvePhase!: (outcome: CodegenOutcome) => void;
    const runCodegenPhase: RunCodegenPhase = vi.fn(
      ({ onCallStart }) =>
        new Promise<CodegenOutcome>((resolve) => {
          onCallStart();
          resolvePhase = resolve;
        }),
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

    await request(app).post("/api/chat").send({ projectId, message: `/build ${spec}` });
    await request(app).post("/api/chat").send({ projectId, message: "/proceed" });

    const response = await request(app).get(`/api/projects/${projectId}/progress`);

    expect(response.body.progress).toMatchObject({ agentLabel: "Codegen Agent" });
    expect(typeof response.body.progress.callStartedAt).toBe("number");

    resolvePhase({ kind: "done", content: "done" });
    await flush();
  });

  it("resets totals to zero when a new phase starts for the same project", async () => {
    const spec = "## Resource\nTask\n";
    const runIntakePhase = fakeRunIntakePhase({ kind: "spec", content: spec });
    const firstCodegenPhase = fakeRunCodegenPhase(
      { kind: "failed", content: "first build failed" },
      [],
      [],
      [{ promptTokens: 500, completionTokens: 100, totalTokens: 600 }],
    );
    let resolveSecond!: (outcome: CodegenOutcome) => void;
    const secondCodegenPhase: RunCodegenPhase = vi.fn(
      () => new Promise<CodegenOutcome>((resolve) => (resolveSecond = resolve)),
    );
    let currentCodegenPhase = firstCodegenPhase as RunCodegenPhase;
    const runCodegenPhase: RunCodegenPhase = (params) => currentCodegenPhase(params);
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

    await request(app).post("/api/chat").send({ projectId, message: `/build ${spec}` });
    await request(app).post("/api/chat").send({ projectId, message: "/proceed" });
    await flush();

    const afterFirst = await request(app).get(`/api/projects/${projectId}/progress`);
    expect(afterFirst.body.progress.totalSentTokens).toBe(500);

    currentCodegenPhase = secondCodegenPhase;
    await request(app).post("/api/chat").send({ projectId, message: `/build ${spec}` });
    await request(app).post("/api/chat").send({ projectId, message: "/proceed" });

    const afterSecondStart = await request(app).get(`/api/projects/${projectId}/progress`);
    expect(afterSecondStart.body.progress.totalSentTokens).toBe(0);

    resolveSecond({ kind: "done", content: "done" });
    await flush();
  });
});

describe("isNoisyProgressMessage", () => {
  it("flags interim [build]/[debug] narration as noisy", () => {
    expect(isNoisyProgressMessage({ role: "assistant", content: "[build] Writing the model..." })).toBe(true);
    expect(isNoisyProgressMessage({ role: "assistant", content: "[build] → write_file: app/models/x.rb" })).toBe(
      true,
    );
    expect(isNoisyProgressMessage({ role: "assistant", content: "[debug] Reading the logs..." })).toBe(true);
  });

  it("flags the [run] pending line as noisy", () => {
    expect(isNoisyProgressMessage({ role: "assistant", content: "[run] Starting your app..." })).toBe(true);
  });

  it("does not flag terminal outcome tags — a real 'what happened' signal is useful, per bug #17", () => {
    expect(isNoisyProgressMessage({ role: "assistant", content: "[build:done] Build complete — ..." })).toBe(false);
    expect(
      isNoisyProgressMessage({ role: "assistant", content: "[build:failed] Build failed: GLM request timed out" }),
    ).toBe(false);
    expect(isNoisyProgressMessage({ role: "assistant", content: "[build:question] What should..." })).toBe(false);
    expect(isNoisyProgressMessage({ role: "assistant", content: "[build:review] Proposed plan..." })).toBe(false);
    expect(isNoisyProgressMessage({ role: "assistant", content: "[run:live] Your app is running..." })).toBe(false);
    expect(isNoisyProgressMessage({ role: "assistant", content: "[run:failed] ..." })).toBe(false);
    expect(isNoisyProgressMessage({ role: "assistant", content: "[debug:done] ..." })).toBe(false);
    expect(isNoisyProgressMessage({ role: "assistant", content: "[stop:done] Stopped..." })).toBe(false);
  });

  it("does not flag plain conversation or user messages", () => {
    expect(isNoisyProgressMessage({ role: "assistant", content: "Sure, happy to help." })).toBe(false);
    expect(isNoisyProgressMessage({ role: "user", content: "[build] this looks like a tag but is a user message" })).toBe(
      false,
    );
    expect(isNoisyProgressMessage({ role: "assistant", content: null })).toBe(false);
  });
});

describe("filterHistoryForIntake", () => {
  it("drops only the noisy interim messages, keeping everything else in order", () => {
    const history = [
      { role: "user" as const, content: "I want email/password login" },
      { role: "assistant" as const, content: "Got it, noted." },
      { role: "user" as const, content: "/build a task tracker" },
      { role: "assistant" as const, content: "[build:review] Proposed plan..." },
      { role: "user" as const, content: "/proceed" },
      { role: "assistant" as const, content: "[build] Got it — starting the build." },
      { role: "assistant" as const, content: "[build] → write_file: app/models/task.rb" },
      { role: "assistant" as const, content: "[build:failed] Build failed: GLM request timed out after 60000ms" },
    ];

    expect(filterHistoryForIntake(history)).toEqual([
      { role: "user", content: "I want email/password login" },
      { role: "assistant", content: "Got it, noted." },
      { role: "user", content: "/build a task tracker" },
      { role: "assistant", content: "[build:review] Proposed plan..." },
      { role: "user", content: "/proceed" },
      { role: "assistant", content: "[build:failed] Build failed: GLM request timed out after 60000ms" },
    ]);
  });
});

describe("slugify", () => {
  it("lowercases, replaces non-alphanumerics with hyphens, and trims edges", () => {
    expect(slugify("Add Reminders to Tasks")).toBe("add-reminders-to-tasks");
    expect(slugify("  Multi   space--title! ")).toBe("multi-space-title");
  });

  it("falls back to a timestamp-based slug for an empty/unsluggable title", () => {
    expect(slugify("")).toMatch(/^feature-\d+$/);
    expect(slugify("!!!")).toMatch(/^feature-\d+$/);
  });
});

describe("deriveFeatureSlug", () => {
  it("extracts the # <Feature Title> line and slugifies it", () => {
    const content = "# Add Reminders\n\n## Resource\nReminder\n\n## Fields\n- due_at: datetime\n";
    expect(deriveFeatureSlug(content)).toBe("add-reminders");
  });

  it("falls back to a timestamp-based slug when there's no title line", () => {
    expect(deriveFeatureSlug("## Resource\nTask\n")).toMatch(/^feature-\d+$/);
  });
});

describe("readExistingProjectContext", () => {
  let workspacePath: string;

  async function withDocs() {
    await mkdir(path.join(workspacePath, "docs/blueprints"), { recursive: true });
  }

  it("returns undefined for a project with no docs/blueprints/features.md at all", async () => {
    workspacePath = await mkdtemp(path.join(tmpdir(), "orchestrator-context-test-"));
    try {
      expect(await readExistingProjectContext(workspacePath)).toBeUndefined();
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("returns undefined while features.md still reads the scaffold's stub text", async () => {
    workspacePath = await mkdtemp(path.join(tmpdir(), "orchestrator-context-test-"));
    try {
      await withDocs();
      await writeFile(
        path.join(workspacePath, "docs/blueprints/features.md"),
        "# Feature Blueprint\n\nNothing built yet beyond the initial structural skeleton.\n",
      );
      expect(await readExistingProjectContext(workspacePath)).toBeUndefined();
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("returns the real features/architecture/backlog content once a build has left real content there — regardless of pass/fail", async () => {
    workspacePath = await mkdtemp(path.join(tmpdir(), "orchestrator-context-test-"));
    try {
      await withDocs();
      await writeFile(path.join(workspacePath, "docs/blueprints/features.md"), "## Current state\n\nA Task resource.");
      await writeFile(path.join(workspacePath, "docs/blueprints/architecture.md"), "Rails + Expo.");
      await writeFile(path.join(workspacePath, "docs/backlog.md"), "| 1 | Initial build | building | | |");

      const context = await readExistingProjectContext(workspacePath);

      expect(context).toEqual({
        features: "## Current state\n\nA Task resource.",
        architecture: "Rails + Expo.",
        backlog: "| 1 | Initial build | building | | |",
      });
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });
});

describe("POST /api/chat — /build against an already-built project", () => {
  it("passes existingContext to runIntakePhase and threads isIncremental through to /proceed", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "orchestrator-incremental-test-"));
    try {
      await mkdir(path.join(workspacePath, "docs/blueprints"), { recursive: true });
      await writeFile(path.join(workspacePath, "docs/blueprints/features.md"), "## Current state\n\nA Task resource.");
      await writeFile(path.join(workspacePath, "docs/blueprints/architecture.md"), "Rails + Expo.");
      await writeFile(path.join(workspacePath, "docs/backlog.md"), "| 1 | Initial build | done | | |");

      const scaffold: Scaffold = vi.fn(async () => workspacePath);
      const runIntakePhase = fakeRunIntakePhase({ kind: "spec", content: "# Add Reminders\n\n## Resource\nReminder\n" });
      const runCodegenPhase = fakeRunCodegenPhase({ kind: "done", content: "done" });
      const app = createApp(
        fakeLlmClient(),
        healthInfo,
        undefined,
        undefined,
        scaffold,
        runIntakePhase,
        runCodegenPhase,
      );
      const created = await request(app).post("/api/projects").send({ name: "GearShare" });
      const projectId = created.body.project.id;

      await request(app).post("/api/chat").send({ projectId, message: "/build add a reminder to each task" });

      expect(runIntakePhase).toHaveBeenCalledWith(
        expect.objectContaining({
          existingContext: {
            features: "## Current state\n\nA Task resource.",
            architecture: "Rails + Expo.",
            backlog: "| 1 | Initial build | done | | |",
          },
        }),
      );

      await request(app).post("/api/chat").send({ projectId, message: "/proceed" });

      expect(runCodegenPhase).toHaveBeenCalledWith(
        expect.objectContaining({ featureSlug: "add-reminders", isIncremental: true }),
      );
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("passes prior plain-chat history to Intake, filtered of noisy progress tags (bug #17)", async () => {
    const runIntakePhase = fakeRunIntakePhase({ kind: "spec", content: "# Task Tracker\n\n## Resource\nTask\n" });
    const app = createApp(
      fakeLlmClient("Got it, noted for later."),
      healthInfo,
      undefined,
      undefined,
      fakeScaffold(),
      runIntakePhase,
    );
    const created = await request(app).post("/api/projects").send({ name: "GearShare" });
    const projectId = created.body.project.id;

    // Plain chat before the /build — should be visible to Intake.
    await request(app).post("/api/chat").send({ projectId, message: "I want email/password login" });
    // A noisy interim progress message that might already be sitting in
    // history from some earlier operation — should NOT be visible.
    // (Appended directly since nothing in this test drives a real build.)

    await request(app).post("/api/chat").send({ projectId, message: "/build a task tracker" });

    expect(runIntakePhase).toHaveBeenCalledWith(
      expect.objectContaining({
        history: [
          { role: "user", content: "I want email/password login" },
          { role: "assistant", content: "Got it, noted for later." },
        ],
      }),
    );
  });

  it("passes existingContext: undefined and isIncremental: false for a fresh project", async () => {
    const runIntakePhase = fakeRunIntakePhase({ kind: "spec", content: "# Task Tracker\n\n## Resource\nTask\n" });
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

    await request(app).post("/api/chat").send({ projectId, message: "/build a task tracker" });

    expect(runIntakePhase).toHaveBeenCalledWith(expect.objectContaining({ existingContext: undefined }));

    await request(app).post("/api/chat").send({ projectId, message: "/proceed" });

    expect(runCodegenPhase).toHaveBeenCalledWith(
      expect.objectContaining({ featureSlug: "task-tracker", isIncremental: false }),
    );
  });
});
