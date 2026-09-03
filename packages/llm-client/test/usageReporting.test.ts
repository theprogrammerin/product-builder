import { describe, expect, it, vi } from "vitest";
import { withUsageReporting } from "../src/usageReporting.js";
import type { ChatCompletionRequest, ChatCompletionResult, LLMClient } from "../src/types.js";

function fakeClient(result: ChatCompletionResult): LLMClient {
  return { chat: vi.fn().mockResolvedValue(result) };
}

const request: ChatCompletionRequest = { messages: [{ role: "user", content: "hi" }] };

describe("withUsageReporting", () => {
  it("calls onUsage with the result's usage after a successful chat() call", async () => {
    const result: ChatCompletionResult = {
      message: { role: "assistant", content: "hello" },
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
    const onUsage = vi.fn();
    const wrapped = withUsageReporting(fakeClient(result), { onUsage });

    await wrapped.chat(request);

    expect(onUsage).toHaveBeenCalledWith({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });

  it("does not call onUsage when the result has no usage", async () => {
    const result: ChatCompletionResult = {
      message: { role: "assistant", content: "hello" },
      finishReason: "stop",
    };
    const onUsage = vi.fn();
    const wrapped = withUsageReporting(fakeClient(result), { onUsage });

    await wrapped.chat(request);

    expect(onUsage).not.toHaveBeenCalled();
  });

  it("calls onCallStart before delegating to the wrapped client's chat()", async () => {
    const result: ChatCompletionResult = {
      message: { role: "assistant", content: "hello" },
      finishReason: "stop",
    };
    const client = fakeClient(result);
    const order: string[] = [];
    (client.chat as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("chat");
      return result;
    });
    const onCallStart = vi.fn(() => order.push("onCallStart"));
    const wrapped = withUsageReporting(client, { onCallStart, onUsage: vi.fn() });

    await wrapped.chat(request);

    expect(onCallStart).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["onCallStart", "chat"]);
  });

  it("works without an onCallStart hook", async () => {
    const result: ChatCompletionResult = {
      message: { role: "assistant", content: "hello" },
      finishReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
    const onUsage = vi.fn();
    const wrapped = withUsageReporting(fakeClient(result), { onUsage });

    await expect(wrapped.chat(request)).resolves.toBe(result);
    expect(onUsage).toHaveBeenCalledWith(result.usage);
  });

  it("passes the request through unchanged and returns the same result", async () => {
    const result: ChatCompletionResult = {
      message: { role: "assistant", content: "hello" },
      finishReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
    const client = fakeClient(result);
    const wrapped = withUsageReporting(client, { onUsage: vi.fn() });

    const actual = await wrapped.chat(request);

    expect(client.chat).toHaveBeenCalledWith(request);
    expect(actual).toBe(result);
  });
});
