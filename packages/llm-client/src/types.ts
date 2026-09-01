export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** JSON-encoded arguments, as returned by the model. */
    arguments: string;
  };
}

export interface ChatMessage {
  role: ChatRole;
  /** Null when the assistant responds with only tool calls. */
  content: string | null;
  toolCalls?: ToolCall[];
  /** Required on role "tool" messages: the ToolCall.id being answered. */
  toolCallId?: string;
  /** Required on role "tool" messages: the tool/function name. */
  name?: string;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    /** JSON Schema object describing the function's parameters. */
    parameters: Record<string, unknown>;
  };
}

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}

export type FinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | (string & {});

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatCompletionResult {
  message: ChatMessage;
  finishReason: FinishReason;
  usage?: Usage;
  /** Raw provider response, for debugging/logging — not for use in agent logic. */
  raw?: unknown;
}

/**
 * Provider-agnostic interface. GlmClient is the only implementation today,
 * but agent code depends on this, not on GLM specifics, so a second
 * provider or a different GLM-compatible endpoint slots in without
 * touching the Intake/Codegen agents.
 */
export interface LLMClient {
  chat(request: ChatCompletionRequest): Promise<ChatCompletionResult>;
}
