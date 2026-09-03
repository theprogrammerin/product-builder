import type { LLMClient } from "@app-builder/llm-client";

export type IntakeResult =
  | { kind: "spec"; content: string }
  | { kind: "question"; content: string };

export interface RunIntakeOptions {
  llmClient: LLMClient;
  systemPrompt: string;
  description: string;
  maxTokens?: number;
}

export class EmptyIntakeResponseError extends Error {
  constructor() {
    super(
      "Intake Agent got an empty response from the model twice in a row " +
        "— this model spends tokens on hidden reasoning before visible " +
        "output, so this usually means maxTokens was too low for how much " +
        "reasoning this description needed, not that there was nothing to " +
        "say.",
    );
  }
}

const QUESTION_PREFIX = "QUESTION:";
// Higher than the Codegen Agent's 4096 (see
// docs/designs/codegen-agent-milestone-1.md): observed completion-token
// usage for a single extraction call varies widely (roughly 500-2600
// tokens for the same input across runs) purely from this model's hidden
// reasoning, so a bigger ceiling makes it less likely reasoning alone
// crowds out the visible response. See docs/backlog.md bug #2.
const DEFAULT_MAX_TOKENS = 8192;

/**
 * One LLM call, no tool-calling loop: there's no code to write or run
 * here, just a markdown brief (or a clarifying question) to produce. See
 * docs/designs/intake-agent-milestone-1.md.
 *
 * Still one-shot from the *user's* point of view — no back-and-forth
 * conversation — but an empty response (all tokens spent on hidden
 * reasoning, none left to say anything) gets one silent internal retry
 * before giving up, since that's been observed to be transient variance,
 * not a systematic problem with a given description. See bug #2.
 */
export async function runIntake(options: RunIntakeOptions): Promise<IntakeResult> {
  const { llmClient, systemPrompt, description, maxTokens = DEFAULT_MAX_TOKENS } = options;

  const messages = [
    { role: "system" as const, content: systemPrompt },
    { role: "user" as const, content: description },
  ];

  let content: string | null = null;
  for (let attempt = 0; attempt < 2 && !content?.trim(); attempt++) {
    const result = await llmClient.chat({ messages, maxTokens });
    content = result.message.content;
  }

  if (!content || content.trim().length === 0) {
    throw new EmptyIntakeResponseError();
  }

  const trimmed = content.trim();
  if (trimmed.startsWith(QUESTION_PREFIX)) {
    return { kind: "question", content: trimmed.slice(QUESTION_PREFIX.length).trim() };
  }

  return { kind: "spec", content: trimmed };
}
