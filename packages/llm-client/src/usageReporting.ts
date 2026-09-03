import type { ChatCompletionRequest, ChatCompletionResult, LLMClient, Usage } from "./types.js";

export interface UsageReportingHooks {
  /** Fires synchronously before delegating to the wrapped client's chat(). */
  onCallStart?: () => void;
  onUsage: (usage: Usage) => void;
}

/**
 * Wraps an LLMClient so every chat() call reports its token usage (and,
 * optionally, when it started), without the caller needing to inspect
 * ChatCompletionResult.usage itself. Transparent pass-through otherwise —
 * same request in, same result out. Lets any agent (present or future)
 * get usage reporting for free just by being handed a wrapped client,
 * with zero agent-side code.
 */
export function withUsageReporting(client: LLMClient, hooks: UsageReportingHooks): LLMClient {
  return {
    async chat(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
      hooks.onCallStart?.();
      const result = await client.chat(request);
      if (result.usage) hooks.onUsage(result.usage);
      return result;
    },
  };
}
