import type { GlmConfig } from "./config.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResult,
  ChatMessage,
  LLMClient,
  ToolCall,
} from "./types.js";

export class GlmRequestError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: unknown,
  ) {
    super(message);
  }
}

interface WireMessage {
  role: string;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface WireResponse {
  choices: Array<{
    message: WireMessage;
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

/**
 * LLMClient implementation for any GLM-API-compatible endpoint
 * (OpenAI-style `POST {baseUrl}/chat/completions`) — Zhipu's hosted GLM
 * API, a self-hosted GLM deployment, or any other endpoint speaking the
 * same wire format. Fully driven by the injected GlmConfig; no
 * provider-specific behavior lives outside this file.
 */
export class GlmClient implements LLMClient {
  constructor(
    private readonly config: GlmConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async chat(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    const body = {
      model: this.config.model,
      messages: request.messages.map(toWireMessage),
      ...(request.tools ? { tools: request.tools } : {}),
      ...(request.temperature !== undefined
        ? { temperature: request.temperature }
        : {}),
      ...(request.maxTokens !== undefined
        ? { max_tokens: request.maxTokens }
        : {}),
    };

    const raw = await this.postWithRetry(body);
    const choice = raw.choices[0];
    if (!choice) {
      throw new GlmRequestError("GLM response contained no choices", undefined, raw);
    }

    return {
      message: fromWireMessage(choice.message),
      finishReason: choice.finish_reason,
      usage: raw.usage
        ? {
            promptTokens: raw.usage.prompt_tokens,
            completionTokens: raw.usage.completion_tokens,
            totalTokens: raw.usage.total_tokens,
          }
        : undefined,
      raw,
    };
  }

  private async postWithRetry(body: unknown): Promise<WireResponse> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (attempt > 0) {
        await sleep(backoffMs(attempt));
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

      try {
        const response = await this.fetchImpl(
          `${this.config.baseUrl}/chat/completions`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${this.config.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          },
        );

        if (!response.ok) {
          const responseBody = await safeJson(response);
          const error = new GlmRequestError(
            `GLM request failed with status ${response.status}`,
            response.status,
            responseBody,
          );
          if (RETRYABLE_STATUS.has(response.status) && attempt < this.config.maxRetries) {
            lastError = error;
            continue;
          }
          throw error;
        }

        return (await response.json()) as WireResponse;
      } catch (error) {
        lastError = error;
        const isAbort = error instanceof Error && error.name === "AbortError";
        const isGlmError = error instanceof GlmRequestError;
        if (attempt < this.config.maxRetries && (isAbort || !isGlmError)) {
          continue;
        }
        if (isAbort) {
          throw new GlmRequestError(
            `GLM request timed out after ${this.config.timeoutMs}ms`,
          );
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new GlmRequestError("GLM request failed for an unknown reason");
  }
}

function toWireMessage(message: ChatMessage): WireMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.toolCalls ? { tool_calls: message.toolCalls } : {}),
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    ...(message.name ? { name: message.name } : {}),
  };
}

function fromWireMessage(message: WireMessage): ChatMessage {
  return {
    role: message.role as ChatMessage["role"],
    content: message.content,
    ...(message.tool_calls ? { toolCalls: message.tool_calls } : {}),
    ...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}),
    ...(message.name ? { name: message.name } : {}),
  };
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 8000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
