import { describe, expect, it, vi } from "vitest";
import type { CommandResult, DockerRunner, FileTools, RunOptions, RunResult } from "@app-builder/codegen-agent";
import type { LLMClient } from "@app-builder/llm-client";
import { runDebugAgent, type RunDebugAgentDeps } from "../src/agent.js";

const passingRspec: CommandResult = { exitCode: 0, stdout: "19 examples, 0 failures\n", stderr: "" };
const passingJest: CommandResult = { exitCode: 0, stdout: "", stderr: "Tests: 5 passed, 5 total\n" };
const failingRspec: CommandResult = { exitCode: 1, stdout: "19 examples, 2 failures\n", stderr: "" };

function fakeDocker(verifyResult: CommandResult): DockerRunner & { run: ReturnType<typeof vi.fn>; down: ReturnType<typeof vi.fn> } {
  return { run: vi.fn().mockResolvedValue(verifyResult), down: vi.fn().mockResolvedValue(undefined) };
}

function makeDeps(overrides: Partial<RunDebugAgentDeps> = {}): RunDebugAgentDeps {
  const backendDocker = fakeDocker(passingRspec);
  const frontendDocker = fakeDocker(passingJest);
  let call = 0;
  const dockers = [backendDocker, frontendDocker];

  return {
    createDockerRunner: vi.fn(() => dockers[call++ % 2]) as unknown as RunDebugAgentDeps["createDockerRunner"],
    createFileTools: vi.fn(() => ({}) as FileTools),
    runCodegenLoop: vi.fn(async (): Promise<RunResult> => ({ iterations: 1, converged: true, transcript: [] })),
    assembleInitialContext: vi.fn(async () => ({ contextText: "context" })),
    ...overrides,
  };
}

const llmClient = {} as LLMClient;

describe("runDebugAgent", () => {
  it("runs a backend pass then a frontend pass, then re-verifies both sides", async () => {
    const deps = makeDeps();
    const result = await runDebugAgent({ llmClient, workspacePath: "/workspace", description: "bug" }, deps);

    expect(deps.assembleInitialContext).toHaveBeenCalledWith(
      expect.objectContaining({ description: "bug", workspacePath: "/workspace" }),
    );
    // Backend pass, frontend pass, and the forced doc-logging epilogue
    // (bug #19) — see docs/designs/build-context-and-resume.md.
    expect(deps.runCodegenLoop).toHaveBeenCalledTimes(3);

    const [backendCall, frontendCall, epilogueCall] = (deps.runCodegenLoop as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as RunOptions,
    );
    expect(backendCall.buildSpec).toBe("context");
    expect(backendCall.systemPrompt).toContain("BACKEND");
    expect(frontendCall.systemPrompt).toContain("FRONTEND");
    expect(epilogueCall.systemPrompt).toContain("19 examples, 0 failures");
    expect(epilogueCall.systemPrompt).toContain("Tests: 5 passed, 5 total");

    expect(result.fixed).toBe(true);
    expect(result.summary).toContain("19 examples, 0 failures");
    expect(result.summary).toContain("Tests: 5 passed, 5 total");
  });

  it("reports fixed: false if either side's final verification still fails", async () => {
    const backendDocker = fakeDocker(failingRspec);
    const frontendDocker = fakeDocker(passingJest);
    let call = 0;
    const dockers = [backendDocker, frontendDocker];
    const deps = makeDeps({
      createDockerRunner: vi.fn(() => dockers[call++ % 2]) as unknown as RunDebugAgentDeps["createDockerRunner"],
    });

    const result = await runDebugAgent({ llmClient, workspacePath: "/workspace" }, deps);

    expect(result.fixed).toBe(false);
    expect(result.summary).toContain("19 examples, 2 failures");
  });

  it("tears down containers when the project isn't currently live", async () => {
    const deps = makeDeps();
    await runDebugAgent({ llmClient, workspacePath: "/workspace" }, deps);

    const backendDocker = (deps.createDockerRunner as ReturnType<typeof vi.fn>).mock.results[0]!.value as ReturnType<
      typeof fakeDocker
    >;
    expect(backendDocker.down).toHaveBeenCalledTimes(1);
  });

  it("does NOT tear down containers when the project is currently live via the Run Agent", async () => {
    const deps = makeDeps();
    await runDebugAgent(
      {
        llmClient,
        workspacePath: "/workspace",
        liveComponents: [{ name: "rails", url: "http://localhost:41000" }],
      },
      deps,
    );

    const backendDocker = (deps.createDockerRunner as ReturnType<typeof vi.fn>).mock.results[0]!.value as ReturnType<
      typeof fakeDocker
    >;
    expect(backendDocker.down).not.toHaveBeenCalled();
  });

  it("still tears down on a thrown error, when not live", async () => {
    const deps = makeDeps({
      runCodegenLoop: vi.fn(async () => {
        throw new Error("docker daemon not running");
      }),
    });

    await expect(runDebugAgent({ llmClient, workspacePath: "/workspace" }, deps)).rejects.toThrow(
      "docker daemon not running",
    );

    const backendDocker = (deps.createDockerRunner as ReturnType<typeof vi.fn>).mock.results[0]!.value as ReturnType<
      typeof fakeDocker
    >;
    expect(backendDocker.down).toHaveBeenCalledTimes(1);
  });

  it("still attempts the doc-logging epilogue after a thrown error, mentioning it in the outcome (bug #19)", async () => {
    let call = 0;
    const deps = makeDeps({
      runCodegenLoop: vi.fn(async (options: RunOptions): Promise<RunResult> => {
        call += 1;
        if (call === 1) throw new Error("GLM request timed out after 60000ms");
        // The epilogue call (2nd — the backend pass threw before the
        // frontend pass could even run) — assert it saw the failure.
        expect(options.systemPrompt).toContain("GLM request timed out after 60000ms");
        return { iterations: 1, converged: true, transcript: [] };
      }),
    });

    await expect(runDebugAgent({ llmClient, workspacePath: "/workspace" }, deps)).rejects.toThrow(
      "GLM request timed out after 60000ms",
    );

    expect(deps.runCodegenLoop).toHaveBeenCalledTimes(2);
  });
});
