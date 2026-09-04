import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionResult, LLMClient } from "@app-builder/llm-client";
import { defaultFrontendMaxIterations, defaultMaxIterations, runCodegenAgent, runCodegenLoop } from "../src/agent.js";
import type { DockerRunner } from "../src/dockerExec.js";
import type { FileTools } from "../src/tools.js";

const buildSpec = "## Resource\nTask\n\n## Fields\n- title: string\n";

const multiResourceSpec =
  "## Resource\nList\n\n## Fields\n- name: string\n\n## Associations\n- has_many :items\n\n" +
  "## Resource\nItem\n\n## Fields\n- title: string\n\n## Associations\n- belongs_to :list\n";

describe("defaultMaxIterations", () => {
  it("stays at the proven single-resource floor for a one-resource spec", () => {
    expect(defaultMaxIterations(buildSpec)).toBe(25);
  });

  it("scales up for a multi-resource spec (bug/feature: multi-resource-support)", () => {
    expect(defaultMaxIterations(multiResourceSpec)).toBe(40);
  });

  it("falls back to the floor for a spec with no recognizable ## Resource heading", () => {
    expect(defaultMaxIterations("just some free text, no headings")).toBe(25);
  });
});

describe("defaultFrontendMaxIterations", () => {
  const twoScreenSpec =
    "## Resource\nTask\n\n## Fields\n- title: string\n\n## Screens\n" +
    "### Task List\nObjective: ...\nShows: ...\n\n### Task Edit\nObjective: ...\nShows: ...\n";

  it("stays at the higher frontend floor for a small number of screens", () => {
    // 2 screens * 15 < the 40 floor, so the floor wins.
    expect(defaultFrontendMaxIterations(twoScreenSpec)).toBe(40);
  });

  it("scales up for a spec with many screens", () => {
    const manyScreens =
      "## Screens\n" + Array.from({ length: 6 }, (_, i) => `### Screen ${i}\nObjective: ...\nShows: ...`).join("\n\n");
    expect(defaultFrontendMaxIterations(manyScreens)).toBe(90); // 6 * 15
  });

  it("falls back to the floor for a spec with no recognizable ### screen heading", () => {
    expect(defaultFrontendMaxIterations("just some free text, no headings")).toBe(40);
  });
});

function fakeFileTools(): FileTools & { writeFile: ReturnType<typeof vi.fn> } {
  return {
    readFile: vi.fn(async () => "file contents"),
    writeFile: vi.fn(async () => undefined),
    listDir: vi.fn(async () => ["a.rb"]),
    listFiles: vi.fn(async () => ["app/models/a.rb"]),
    searchFiles: vi.fn(async () => []),
  };
}

function fakeDockerRunner(): DockerRunner & { run: ReturnType<typeof vi.fn> } {
  return {
    run: vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "" })),
    down: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  };
}

function llmClientReturning(...results: ChatCompletionResult[]): LLMClient & {
  chat: ReturnType<typeof vi.fn>;
} {
  const chat = vi.fn();
  results.forEach((result) => chat.mockImplementationOnce(async () => result));
  return { chat };
}

describe("runCodegenAgent", () => {
  it("reports success and parses the rspec summary when the final verification passes", async () => {
    const fileTools = fakeFileTools();
    const dockerRunner = fakeDockerRunner();
    dockerRunner.run = vi.fn(async (command: string) =>
      command === "bundle exec rspec"
        ? { exitCode: 0, stdout: "..............\n\n31 examples, 0 failures\n", stderr: "" }
        : { exitCode: 0, stdout: "ok", stderr: "" },
    );
    const llmClient = llmClientReturning({ message: { role: "assistant", content: "done" }, finishReason: "stop" });

    const result = await runCodegenAgent({ llmClient, systemPrompt: "system", buildSpec, fileTools, dockerRunner });

    expect(result.testsPassed).toBe(true);
    expect(result.verifySummary).toBe("31 examples, 0 failures");
    expect(dockerRunner.run).toHaveBeenCalledWith("bundle exec rspec");
  });

  it("reports failure when the final verification's exit code is non-zero", async () => {
    const fileTools = fakeFileTools();
    const dockerRunner = fakeDockerRunner();
    dockerRunner.run = vi.fn(async (command: string) =>
      command === "bundle exec rspec"
        ? { exitCode: 1, stdout: "...F\n\n1) failure\n\n31 examples, 1 failure\n", stderr: "" }
        : { exitCode: 0, stdout: "ok", stderr: "" },
    );
    const llmClient = llmClientReturning({ message: { role: "assistant", content: "done" }, finishReason: "stop" });

    const result = await runCodegenAgent({ llmClient, systemPrompt: "system", buildSpec, fileTools, dockerRunner });

    expect(result.testsPassed).toBe(false);
    expect(result.verifySummary).toBe("31 examples, 1 failure");
  });

  it("falls back to the exit code when rspec's summary line can't be found", async () => {
    const fileTools = fakeFileTools();
    const dockerRunner = fakeDockerRunner();
    dockerRunner.run = vi.fn(async (command: string) =>
      command === "bundle exec rspec"
        ? { exitCode: 1, stdout: "", stderr: "boom" }
        : { exitCode: 0, stdout: "ok", stderr: "" },
    );
    const llmClient = llmClientReturning({ message: { role: "assistant", content: "done" }, finishReason: "stop" });

    const result = await runCodegenAgent({ llmClient, systemPrompt: "system", buildSpec, fileTools, dockerRunner });

    expect(result.testsPassed).toBe(false);
    expect(result.verifySummary).toBe("bundle exec rspec exited 1");
  });

  it("uses a custom verifyCommand (e.g. the frontend phase's npx jest) instead of bundle exec rspec", async () => {
    const fileTools = fakeFileTools();
    const dockerRunner = fakeDockerRunner();
    // Jest's own summary reporter writes to stderr, not stdout — a real
    // run went unreported as its actual "18 passed, 3 failed" and fell
    // back to a bare exit-code message every time until this was fixed
    // to search both streams.
    dockerRunner.run = vi.fn(async (command: string) =>
      command === "npx jest"
        ? { exitCode: 0, stdout: "", stderr: "Tests: 3 passed, 3 total\n" }
        : { exitCode: 0, stdout: "ok", stderr: "" },
    );
    const llmClient = llmClientReturning({ message: { role: "assistant", content: "done" }, finishReason: "stop" });

    const result = await runCodegenAgent({
      llmClient,
      systemPrompt: "system",
      buildSpec,
      fileTools,
      dockerRunner,
      verifyCommand: "npx jest",
    });

    expect(result.testsPassed).toBe(true);
    expect(result.verifySummary).toBe("Tests: 3 passed, 3 total");
    expect(dockerRunner.run).toHaveBeenCalledWith("npx jest");
    expect(dockerRunner.run).not.toHaveBeenCalledWith("bundle exec rspec");
  });

  it("does not tear down the docker runner itself — that stays the caller's job", async () => {
    const fileTools = fakeFileTools();
    const dockerRunner = fakeDockerRunner();
    const llmClient = llmClientReturning({ message: { role: "assistant", content: "done" }, finishReason: "stop" });

    await runCodegenAgent({ llmClient, systemPrompt: "system", buildSpec, fileTools, dockerRunner });

    expect(dockerRunner.down).not.toHaveBeenCalled();
  });
});

describe("runCodegenLoop", () => {
  it("executes a write_file tool call, feeds the result back, and stops when the model responds with plain text", async () => {
    const fileTools = fakeFileTools();
    const dockerRunner = fakeDockerRunner();
    const llmClient = llmClientReturning(
      {
        message: {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "write_file", arguments: JSON.stringify({ path: "app/models/task.rb", content: "class Task; end" }) },
            },
          ],
        },
        finishReason: "tool_calls",
      },
      {
        message: { role: "assistant", content: "Done implementing Task." },
        finishReason: "stop",
      },
    );

    const result = await runCodegenLoop({
      llmClient,
      systemPrompt: "system",
      buildSpec,
      fileTools,
      dockerRunner,
    });

    expect(result.converged).toBe(true);
    expect(result.iterations).toBe(2);
    expect(fileTools.writeFile).toHaveBeenCalledWith("app/models/task.rb", "class Task; end");

    const toolResultMessage = result.transcript.find((m) => m.role === "tool");
    expect(toolResultMessage).toMatchObject({ toolCallId: "call_1", name: "write_file", content: "ok" });
  });

  it("runs run_command tool calls through the docker runner", async () => {
    const fileTools = fakeFileTools();
    const dockerRunner = fakeDockerRunner();
    const llmClient = llmClientReturning(
      {
        message: {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "run_command", arguments: JSON.stringify({ command: "bundle install" }) },
            },
          ],
        },
        finishReason: "tool_calls",
      },
      { message: { role: "assistant", content: "done" }, finishReason: "stop" },
    );

    await runCodegenLoop({ llmClient, systemPrompt: "system", buildSpec, fileTools, dockerRunner });

    expect(dockerRunner.run).toHaveBeenCalledWith("bundle install");
  });

  it("routes list_files calls to fileTools.listFiles", async () => {
    const fileTools = fakeFileTools();
    const dockerRunner = fakeDockerRunner();
    const llmClient = llmClientReturning(
      {
        message: {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "list_files", arguments: JSON.stringify({ path: "app" }) },
            },
          ],
        },
        finishReason: "tool_calls",
      },
      { message: { role: "assistant", content: "done" }, finishReason: "stop" },
    );

    const result = await runCodegenLoop({ llmClient, systemPrompt: "system", buildSpec, fileTools, dockerRunner });

    expect(fileTools.listFiles).toHaveBeenCalledWith("app");
    const toolResultMessage = result.transcript.find((m) => m.role === "tool");
    expect(toolResultMessage?.content).toBe("app/models/a.rb");
  });

  it("routes search_files calls to fileTools.searchFiles and formats matches", async () => {
    const fileTools = fakeFileTools();
    fileTools.searchFiles = vi.fn(async () => [
      { path: "app/models/task.rb", line: 3, text: "class Task < ApplicationRecord" },
    ]);
    const dockerRunner = fakeDockerRunner();
    const llmClient = llmClientReturning(
      {
        message: {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "search_files", arguments: JSON.stringify({ pattern: "class Task" }) },
            },
          ],
        },
        finishReason: "tool_calls",
      },
      { message: { role: "assistant", content: "done" }, finishReason: "stop" },
    );

    const result = await runCodegenLoop({ llmClient, systemPrompt: "system", buildSpec, fileTools, dockerRunner });

    expect(fileTools.searchFiles).toHaveBeenCalledWith("class Task", undefined);
    const toolResultMessage = result.transcript.find((m) => m.role === "tool");
    expect(toolResultMessage?.content).toBe("app/models/task.rb:3: class Task < ApplicationRecord");
  });

  it("does not converge on an empty response (no tool calls, no content) — nudges and keeps going", async () => {
    const fileTools = fakeFileTools();
    const dockerRunner = fakeDockerRunner();
    const llmClient = llmClientReturning(
      { message: { role: "assistant", content: null }, finishReason: "stop" },
      { message: { role: "assistant", content: "" }, finishReason: "stop" },
      { message: { role: "assistant", content: "Actually done now." }, finishReason: "stop" },
    );

    const result = await runCodegenLoop({ llmClient, systemPrompt: "system", buildSpec, fileTools, dockerRunner });

    expect(result.converged).toBe(true);
    expect(result.iterations).toBe(3);
    expect(llmClient.chat).toHaveBeenCalledTimes(3);
    const userNudges = result.transcript.filter(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("empty turn"),
    );
    expect(userNudges).toHaveLength(2);
  });

  it("fires an empty_turn event with the real finishReason instead of leaving the caller with total silence", async () => {
    const fileTools = fakeFileTools();
    const dockerRunner = fakeDockerRunner();
    const llmClient = llmClientReturning(
      { message: { role: "assistant", content: null }, finishReason: "length" },
      { message: { role: "assistant", content: "Actually done now." }, finishReason: "stop" },
    );
    const onEvent = vi.fn();

    await runCodegenLoop({ llmClient, systemPrompt: "system", buildSpec, fileTools, dockerRunner, onEvent });

    expect(onEvent).toHaveBeenCalledWith({ type: "empty_turn", finishReason: "length" });
  });

  it("does not expose read_project_doc/write_project_doc when projectDocsTools isn't supplied", async () => {
    const fileTools = fakeFileTools();
    const dockerRunner = fakeDockerRunner();
    const llmClient = llmClientReturning({ message: { role: "assistant", content: "done" }, finishReason: "stop" });

    await runCodegenLoop({ llmClient, systemPrompt: "system", buildSpec, fileTools, dockerRunner });

    const toolNames = llmClient.chat.mock.calls[0][0].tools.map((t: { function: { name: string } }) => t.function.name);
    expect(toolNames).not.toContain("read_project_doc");
    expect(toolNames).not.toContain("write_project_doc");
  });

  it("appends read_project_doc/write_project_doc to the tool schema when projectDocsTools is supplied, and dispatches to it", async () => {
    const fileTools = fakeFileTools();
    const dockerRunner = fakeDockerRunner();
    const projectDocsTools = { read: vi.fn(async () => "existing content"), write: vi.fn(async () => undefined) };
    const llmClient = llmClientReturning(
      {
        message: {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "1",
              type: "function",
              function: { name: "write_project_doc", arguments: JSON.stringify({ path: "docs/backlog.md", content: "row" }) },
            },
          ],
        },
        finishReason: "tool_calls",
      },
      { message: { role: "assistant", content: "done" }, finishReason: "stop" },
    );

    await runCodegenLoop({ llmClient, systemPrompt: "system", buildSpec, fileTools, dockerRunner, projectDocsTools });

    const toolNames = llmClient.chat.mock.calls[0][0].tools.map((t: { function: { name: string } }) => t.function.name);
    expect(toolNames).toEqual(
      expect.arrayContaining(["read_file", "write_file", "read_project_doc", "write_project_doc"]),
    );
    expect(projectDocsTools.write).toHaveBeenCalledWith("docs/backlog.md", "row");
  });

  it("an explicit toolDefinitions override still wins even when projectDocsTools is also supplied", async () => {
    const fileTools = fakeFileTools();
    const dockerRunner = fakeDockerRunner();
    const projectDocsTools = { read: vi.fn(), write: vi.fn() };
    const customTools = [
      { type: "function" as const, function: { name: "only_this_tool", description: "d", parameters: {} } },
    ];
    const llmClient = llmClientReturning({ message: { role: "assistant", content: "done" }, finishReason: "stop" });

    await runCodegenLoop({
      llmClient,
      systemPrompt: "system",
      buildSpec,
      fileTools,
      dockerRunner,
      projectDocsTools,
      toolDefinitions: customTools,
    });

    expect(llmClient.chat.mock.calls[0][0].tools).toEqual(customTools);
  });

  it("passes a generous maxTokens on every call to avoid truncated/empty responses", async () => {
    const fileTools = fakeFileTools();
    const dockerRunner = fakeDockerRunner();
    const llmClient = llmClientReturning({ message: { role: "assistant", content: "done" }, finishReason: "stop" });

    await runCodegenLoop({ llmClient, systemPrompt: "system", buildSpec, fileTools, dockerRunner });

    const callArgs = llmClient.chat.mock.calls[0][0];
    expect(callArgs.maxTokens).toBeGreaterThanOrEqual(2048);
  });

  it("stops after maxIterations if the model never stops calling tools", async () => {
    const fileTools = fakeFileTools();
    const dockerRunner = fakeDockerRunner();
    const alwaysToolCall: ChatCompletionResult = {
      message: {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "call_x",
            type: "function",
            function: { name: "list_dir", arguments: JSON.stringify({ path: "." }) },
          },
        ],
      },
      finishReason: "tool_calls",
    };
    const chat = vi.fn(async () => alwaysToolCall);
    const llmClient: LLMClient = { chat };

    const result = await runCodegenLoop({
      llmClient,
      systemPrompt: "system",
      buildSpec,
      fileTools,
      dockerRunner,
      maxIterations: 3,
    });

    expect(result.converged).toBe(false);
    expect(result.iterations).toBe(3);
    expect(chat).toHaveBeenCalledTimes(3);
  });

  it("turns a tool execution error into a tool result instead of throwing", async () => {
    const fileTools = fakeFileTools();
    fileTools.readFile = vi.fn(async () => {
      throw new Error("boom");
    });
    const dockerRunner = fakeDockerRunner();
    const llmClient = llmClientReturning(
      {
        message: {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: JSON.stringify({ path: "missing.rb" }) },
            },
          ],
        },
        finishReason: "tool_calls",
      },
      { message: { role: "assistant", content: "done" }, finishReason: "stop" },
    );

    const result = await runCodegenLoop({ llmClient, systemPrompt: "system", buildSpec, fileTools, dockerRunner });

    const toolResultMessage = result.transcript.find((m) => m.role === "tool");
    expect(toolResultMessage?.content).toContain("Error: boom");
  });
});
