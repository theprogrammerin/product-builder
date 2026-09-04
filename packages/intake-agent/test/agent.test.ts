import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionResult, LLMClient } from "@app-builder/llm-client";
import { EmptyIntakeResponseError, runIntake } from "../src/agent.js";

function llmClientReturning(result: ChatCompletionResult): LLMClient & {
  chat: ReturnType<typeof vi.fn>;
} {
  return { chat: vi.fn(async () => result) };
}

function llmClientReturningSequence(...results: ChatCompletionResult[]): LLMClient & {
  chat: ReturnType<typeof vi.fn>;
} {
  const chat = vi.fn();
  results.forEach((result) => chat.mockImplementationOnce(async () => result));
  return { chat };
}

describe("runIntake", () => {
  it("returns a spec result for an ordinary markdown brief", async () => {
    const llmClient = llmClientReturning({
      message: { role: "assistant", content: "## Resource\nTask\n\n## Fields\n- title: string" },
      finishReason: "stop",
    });

    const result = await runIntake({
      llmClient,
      systemPrompt: "system",
      description: "a task tracker with a title field",
    });

    expect(result).toEqual({
      kind: "spec",
      content: "## Resource\nTask\n\n## Fields\n- title: string",
    });
  });

  it("inserts prior chat history between the system prompt and the current description (bug #17)", async () => {
    const llmClient = llmClientReturning({
      message: { role: "assistant", content: "## Resource\nTask\n" },
      finishReason: "stop",
    });
    const history = [
      { role: "user" as const, content: "I want it to use email/password login" },
      { role: "assistant" as const, content: "Got it, noted for later." },
    ];

    await runIntake({ llmClient, systemPrompt: "system", description: "a task tracker", history });

    expect(llmClient.chat).toHaveBeenCalledWith({
      messages: [
        { role: "system", content: "system" },
        ...history,
        { role: "user", content: "a task tracker" },
      ],
      maxTokens: 8192,
    });
  });

  it("works with no history at all (standalone CLI usage, unaffected)", async () => {
    const llmClient = llmClientReturning({
      message: { role: "assistant", content: "## Resource\nTask\n" },
      finishReason: "stop",
    });

    await runIntake({ llmClient, systemPrompt: "system", description: "a task tracker" });

    expect(llmClient.chat).toHaveBeenCalledWith({
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "a task tracker" },
      ],
      maxTokens: 8192,
    });
  });

  it("recognizes a QUESTION: response and strips the marker", async () => {
    const llmClient = llmClientReturning({
      message: { role: "assistant", content: "QUESTION:\nWhat should the resource be called?" },
      finishReason: "stop",
    });

    const result = await runIntake({
      llmClient,
      systemPrompt: "system",
      description: "build me something",
    });

    expect(result).toEqual({ kind: "question", content: "What should the resource be called?" });
  });

  it("throws EmptyIntakeResponseError if both the initial call and the retry come back empty", async () => {
    const llmClient = llmClientReturningSequence(
      { message: { role: "assistant", content: "" }, finishReason: "stop" },
      { message: { role: "assistant", content: null }, finishReason: "stop" },
    );

    await expect(
      runIntake({ llmClient, systemPrompt: "system", description: "anything" }),
    ).rejects.toBeInstanceOf(EmptyIntakeResponseError);
    expect(llmClient.chat).toHaveBeenCalledTimes(2);
  });

  it("retries once and succeeds if the first response is empty but the retry isn't (bug #2)", async () => {
    const llmClient = llmClientReturningSequence(
      { message: { role: "assistant", content: null }, finishReason: "stop" },
      {
        message: { role: "assistant", content: "## Resource\nTask\n\n## Fields\n- title: string" },
        finishReason: "stop",
      },
    );

    const result = await runIntake({ llmClient, systemPrompt: "system", description: "a task tracker" });

    expect(result).toEqual({ kind: "spec", content: "## Resource\nTask\n\n## Fields\n- title: string" });
    expect(llmClient.chat).toHaveBeenCalledTimes(2);
  });

  it("passes a generous maxTokens by default", async () => {
    const llmClient = llmClientReturning({
      message: { role: "assistant", content: "## Resource\nTask\n\n## Fields\n- title: string" },
      finishReason: "stop",
    });

    await runIntake({ llmClient, systemPrompt: "system", description: "a task tracker" });

    const callArgs = llmClient.chat.mock.calls[0][0];
    expect(callArgs.maxTokens).toBeGreaterThanOrEqual(4096);
  });

  it("sends the description as the user message and the system prompt as-is", async () => {
    const llmClient = llmClientReturning({
      message: { role: "assistant", content: "## Resource\nTask\n\n## Fields\n- title: string" },
      finishReason: "stop",
    });

    await runIntake({ llmClient, systemPrompt: "system prompt text", description: "user's description" });

    const callArgs = llmClient.chat.mock.calls[0][0];
    expect(callArgs.messages).toEqual([
      { role: "system", content: "system prompt text" },
      { role: "user", content: "user's description" },
    ]);
  });
});
