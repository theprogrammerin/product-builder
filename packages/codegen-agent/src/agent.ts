import type { ChatMessage, LLMClient } from "@app-builder/llm-client";
import type { DockerRunner } from "./dockerExec.js";
import type { BuildSpec } from "./promptContext.js";
import { TOOL_DEFINITIONS, type FileTools } from "./tools.js";

export interface RunResult {
  iterations: number;
  /** true if the model stopped calling tools on its own; false if the iteration cap was hit. */
  converged: boolean;
  transcript: ChatMessage[];
}

export type AgentEvent =
  | { type: "assistant_message"; content: string | null }
  | { type: "tool_call"; name: string; args: unknown }
  | { type: "tool_result"; name: string; result: string };

export interface RunOptions {
  llmClient: LLMClient;
  systemPrompt: string;
  buildSpec: BuildSpec;
  fileTools: FileTools;
  dockerRunner: DockerRunner;
  maxIterations?: number;
  onEvent?: (event: AgentEvent) => void;
}

const DEFAULT_MAX_ITERATIONS = 25;
// Generous: this model spends tokens on hidden reasoning before visible
// output, so a small cap risks silently truncating to empty content.
const DEFAULT_MAX_TOKENS = 4096;

const EMPTY_RESPONSE_NUDGE =
  "Your last response had no tool calls and no content — that isn't a " +
  "completed task, it's an empty turn. If you're not actually done " +
  "(files written, bundle install run, migrations run, tests passing), " +
  "keep going: call a tool. Only respond with plain text once the work " +
  "is genuinely finished.";

/**
 * The core tool-calling loop. Runs until the model responds with
 * non-empty plain text and no tool calls (it believes it's done) or
 * maxIterations is hit. Does NOT itself decide whether the result is
 * actually correct — that's the caller's job (a final `bundle exec
 * rspec` run), by design: the model's own "I'm done" is never the source
 * of truth. See docs/designs/codegen-agent-milestone-1.md.
 */
export async function runCodegenLoop(options: RunOptions): Promise<RunResult> {
  const {
    llmClient,
    systemPrompt,
    buildSpec,
    fileTools,
    dockerRunner,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    onEvent,
  } = options;

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Build spec:\n${JSON.stringify(buildSpec, null, 2)}` },
  ];

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const result = await llmClient.chat({
      messages,
      tools: TOOL_DEFINITIONS,
      maxTokens: DEFAULT_MAX_TOKENS,
    });
    messages.push(result.message);
    onEvent?.({ type: "assistant_message", content: result.message.content });

    const hasToolCalls = !!result.message.toolCalls && result.message.toolCalls.length > 0;
    const hasContent = !!result.message.content && result.message.content.trim().length > 0;

    if (!hasToolCalls && hasContent) {
      return { iterations: iteration + 1, converged: true, transcript: messages };
    }

    if (!hasToolCalls && !hasContent) {
      // Empty turn — the model neither acted nor said anything meaningful.
      // Don't treat this as "done"; nudge it and keep going.
      messages.push({ role: "user", content: EMPTY_RESPONSE_NUDGE });
      continue;
    }

    for (const call of result.message.toolCalls ?? []) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        args = {};
      }
      onEvent?.({ type: "tool_call", name: call.function.name, args });
      const output = await executeTool(call.function.name, args, fileTools, dockerRunner);
      onEvent?.({ type: "tool_result", name: call.function.name, result: output });
      messages.push({
        role: "tool",
        content: output,
        toolCallId: call.id,
        name: call.function.name,
      });
    }
  }

  return { iterations: maxIterations, converged: false, transcript: messages };
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  fileTools: FileTools,
  dockerRunner: DockerRunner,
): Promise<string> {
  try {
    switch (name) {
      case "read_file":
        return await fileTools.readFile(String(args.path));
      case "write_file":
        await fileTools.writeFile(String(args.path), String(args.content ?? ""));
        return "ok";
      case "list_dir":
        return (await fileTools.listDir(String(args.path))).join("\n");
      case "list_files": {
        const files = await fileTools.listFiles(args.path ? String(args.path) : undefined);
        return files.length > 0 ? files.join("\n") : "(no files)";
      }
      case "search_files": {
        const matches = await fileTools.searchFiles(
          String(args.pattern),
          args.path ? String(args.path) : undefined,
        );
        return matches.length > 0
          ? matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n")
          : "(no matches)";
      }
      case "run_command": {
        const commandResult = await dockerRunner.run(String(args.command));
        return `exit ${commandResult.exitCode}\n--- stdout ---\n${commandResult.stdout}\n--- stderr ---\n${commandResult.stderr}`;
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
