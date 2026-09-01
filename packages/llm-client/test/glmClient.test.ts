import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlmConfig } from "../src/config.js";
import { GlmClient, GlmRequestError } from "../src/glmClient.js";
import type { ChatCompletionRequest } from "../src/types.js";

const baseConfig: GlmConfig = {
  baseUrl: "https://glm.example.com/api/paas/v4",
  apiKey: "secret-key",
  model: "glm-4.6",
  timeoutMs: 5_000,
  maxRetries: 2,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const successBody = {
  choices: [
    {
      message: { role: "assistant", content: "hello there" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GlmClient.chat", () => {
  it("posts to {baseUrl}/chat/completions with the model, headers, and mapped messages", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, successBody));
    const client = new GlmClient(baseConfig, fetchImpl);

    const request: ChatCompletionRequest = {
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hi" },
      ],
      temperature: 0.2,
    };

    await client.chat(request);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://glm.example.com/api/paas/v4/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer secret-key");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("glm-4.6");
    expect(body.temperature).toBe(0.2);
    expect(body.messages).toEqual([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hi" },
    ]);
  });

  it("maps a successful response back to camelCase result fields", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, successBody));
    const client = new GlmClient(baseConfig, fetchImpl);

    const result = await client.chat({ messages: [{ role: "user", content: "Hi" }] });

    expect(result.message).toEqual({ role: "assistant", content: "hello there" });
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
  });

  it("round-trips assistant tool_calls and tool-result messages through the wire format", async () => {
    const toolCallResponse = {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "write_file", arguments: '{"path":"a.rb"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, toolCallResponse));
    const client = new GlmClient(baseConfig, fetchImpl);

    const result = await client.chat({
      messages: [
        {
          role: "tool",
          content: "file written",
          toolCallId: "call_0",
          name: "write_file",
        },
      ],
      tools: [
        {
          type: "function",
          function: { name: "write_file", description: "Writes a file", parameters: {} },
        },
      ],
    });

    const sentBody = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
    expect(sentBody.messages[0]).toEqual({
      role: "tool",
      content: "file written",
      tool_call_id: "call_0",
      name: "write_file",
    });
    expect(sentBody.tools[0].function.name).toBe("write_file");

    expect(result.message.toolCalls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "write_file", arguments: '{"path":"a.rb"}' },
      },
    ]);
    expect(result.finishReason).toBe("tool_calls");
  });

  it("retries on a 500 and succeeds on the next attempt", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, { error: "boom" }))
      .mockResolvedValueOnce(jsonResponse(200, successBody));
    const client = new GlmClient(baseConfig, fetchImpl);

    const promise = client.chat({ messages: [{ role: "user", content: "Hi" }] });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.message.content).toBe("hello there");
  });

  it("does not retry a non-retryable 400 status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(400, { error: "bad request" }));
    const client = new GlmClient(baseConfig, fetchImpl);

    const promise = client.chat({ messages: [{ role: "user", content: "Hi" }] });
    const assertion = expect(promise).rejects.toThrow(GlmRequestError);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after exhausting retries on repeated 429s", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(429, { error: "rate limited" }));
    const client = new GlmClient(baseConfig, fetchImpl);

    const promise = client.chat({ messages: [{ role: "user", content: "Hi" }] });
    const assertion = expect(promise).rejects.toThrow(GlmRequestError);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchImpl).toHaveBeenCalledTimes(baseConfig.maxRetries + 1);
  });

  it("throws a timeout GlmRequestError when the request exceeds timeoutMs", async () => {
    const config: GlmConfig = { ...baseConfig, timeoutMs: 100, maxRetries: 0 };
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    const client = new GlmClient(config, fetchImpl as unknown as typeof fetch);

    const promise = client.chat({ messages: [{ role: "user", content: "Hi" }] });
    const assertion = expect(promise).rejects.toThrow(/timed out/);
    await vi.runAllTimersAsync();
    await assertion;
  });
});
