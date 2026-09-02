import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionResult, LLMClient } from "@app-builder/llm-client";
import { runCodegenLoop } from "../src/agent.js";
import type { DockerRunner } from "../src/dockerExec.js";
import type { FileTools } from "../src/tools.js";

const buildSpec = { resource: "Task", fields: [{ name: "title", type: "string" }] };

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
