import type { ChatMessage, FinishReason, LLMClient, ToolDefinition } from "@app-builder/llm-client";
import type { DockerRunner } from "./dockerExec.js";
import { PROJECT_DOCS_TOOL_DEFINITIONS, TOOL_DEFINITIONS, type FileTools, type ProjectDocsTools } from "./tools.js";

export interface RunResult {
  iterations: number;
  /** true if the model stopped calling tools on its own; false if the iteration cap was hit. */
  converged: boolean;
  transcript: ChatMessage[];
}

export type AgentEvent =
  | { type: "assistant_message"; content: string | null }
  | { type: "tool_call"; name: string; args: unknown }
  | { type: "tool_result"; name: string; result: string }
  | { type: "empty_turn"; finishReason: FinishReason };

export interface RunOptions {
  llmClient: LLMClient;
  systemPrompt: string;
  buildSpec: string;
  fileTools: FileTools;
  dockerRunner: DockerRunner;
  maxIterations?: number;
  onEvent?: (event: AgentEvent) => void;
  /**
   * Final, authoritative check run after the loop — the model's own
   * "done" claim is never trusted alone. Default: "bundle exec rspec".
   * Only consulted by runCodegenAgent, not runCodegenLoop itself.
   */
  verifyCommand?: string;
  /**
   * Overrides the tool schema shown to the model — same five tool
   * *names* dispatch through executeTool() either way, only the
   * descriptions shown to the model change. Needed by
   * @app-builder/debug-agent: its fileTools root is the whole project
   * (so it can reach CLAUDE.md/docs/backlog.md, not just backend/ or
   * frontend/), so the stock descriptions ("relative to the project's
   * backend/ root") would be actively wrong for it. Defaults to
   * TOOL_DEFINITIONS, unchanged for every existing caller.
   */
  toolDefinitions?: ToolDefinition[];
  /**
   * Gives the model read_project_doc/write_project_doc tools scoped to a
   * fixed allowlist of governance docs (features.md, architecture.md,
   * backlog.md, CHANGELOG.md, docs/designs/<slug>.md) — not a general
   * project-root sandbox like the Debug Agent's. Undefined by default
   * (existing callers unaffected); when supplied, its two tool
   * definitions are appended to the effective toolDefinitions
   * automatically unless toolDefinitions is also overridden explicitly.
   * See docs/designs/intake-iteration.md.
   */
  projectDocsTools?: ProjectDocsTools;
}

// Proven sufficient for one resource in Milestone 1. Floor for the
// scaling formula below, not just a flat default any more — see
// docs/designs/multi-resource-support.md.
const MIN_MAX_ITERATIONS = 25;
const ITERATIONS_PER_RESOURCE = 20;
// Matches intake-agent's ceiling — same model, same "spends tokens on
// hidden reasoning before visible output" behavior (see bug #2), and a
// codegen/debug turn is typically more demanding per turn than Intake's
// one-shot brief (a write_file tool call carries a full file's content
// as an argument, competing with any reasoning tokens for this same
// budget). Previously 4096 — too tight, per bug #15 — which risked
// silently truncating a turn to empty content (no visible text, no tool
// call) well before the model finished reasoning.
const DEFAULT_MAX_TOKENS = 8192;

/**
 * A fixed iteration cap that happened to work for one resource won't
 * scale to a multi-resource build spec. This counts `## Resource`
 * headings — a cheap heuristic, not a real parse of fields/associations,
 * so it doesn't reintroduce the structured-spec parsing this design
 * deliberately avoided elsewhere (see docs/designs/multi-resource-support.md).
 */
export function defaultMaxIterations(buildSpec: string): number {
  const resourceCount = buildSpec.match(/^##\s*Resource\s*$/gim)?.length || 1;
  return Math.max(MIN_MAX_ITERATIONS, resourceCount * ITERATIONS_PER_RESOURCE);
}

// Higher floor than the backend's 25: a live run (single Task resource,
// two screens) hit this cap twice without converging — once at 20
// iterations from an early false "convergence" (the model emitted a
// malformed pseudo-tool-call as plain text instead of a real tool call,
// which the loop correctly-but-unhelpfully read as "done"), and once by
// genuinely running out of room mid-fix at 25. The frontend phase's
// scope per resource is broader than backend's (API client + Zustand
// store + N screens + navigation + three kinds of tests +
// type-checking), so it's scaled by screen count, not resource count.
// See docs/designs/frontend-generation.md.
const MIN_FRONTEND_MAX_ITERATIONS = 40;
const ITERATIONS_PER_SCREEN = 15;

/**
 * Counts `### <name>` sub-headings under the build spec's `## Screens`
 * section — a cheap heading count, not a real parse, same principle as
 * defaultMaxIterations above.
 */
export function defaultFrontendMaxIterations(buildSpec: string): number {
  const screenCount = buildSpec.match(/^###\s+.+$/gim)?.length || 1;
  return Math.max(MIN_FRONTEND_MAX_ITERATIONS, screenCount * ITERATIONS_PER_SCREEN);
}

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
    maxIterations = defaultMaxIterations(buildSpec),
    onEvent,
    projectDocsTools,
    toolDefinitions = projectDocsTools ? [...TOOL_DEFINITIONS, ...PROJECT_DOCS_TOOL_DEFINITIONS] : TOOL_DEFINITIONS,
  } = options;

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Build spec:\n${buildSpec}` },
  ];

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const result = await llmClient.chat({
      messages,
      tools: toolDefinitions,
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
      // Don't treat this as "done"; nudge it and keep going. Still fire
      // an event (with the real finishReason, for diagnosability) so the
      // caller isn't left with total silence — see bug #15.
      onEvent?.({ type: "empty_turn", finishReason: result.finishReason });
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
      const output = await executeTool(call.function.name, args, fileTools, dockerRunner, projectDocsTools);
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

export interface RunCodegenAgentResult {
  converged: boolean;
  iterations: number;
  testsPassed: boolean;
  /** e.g. "31 examples, 0 failures" (rspec) or "Tests: 3 passed, 3 total" (jest), parsed from the verify command's own stdout. */
  verifySummary: string;
  verifyOutput: string;
}

/**
 * Wraps runCodegenLoop with a final, authoritative verification command —
 * extracted so the CLI and the orchestrator's chat integration (see
 * docs/designs/wire-agents-into-chat.md) share this exact sequence
 * instead of duplicating it. Teardown (`dockerRunner.down()`) stays the
 * caller's responsibility, same as before this extraction.
 *
 * `verifyCommand` defaults to "bundle exec rspec" (backend); the frontend
 * phase passes "npx jest" instead — see
 * docs/designs/frontend-generation.md. Same function either way: only
 * the prompt, file tools, docker service, and this command differ.
 */
export async function runCodegenAgent(options: RunOptions): Promise<RunCodegenAgentResult> {
  const verifyCommand = options.verifyCommand ?? "bundle exec rspec";
  const loopResult = await runCodegenLoop(options);
  const verification = await options.dockerRunner.run(verifyCommand);
  // Jest writes its own summary reporter output to stderr, not stdout —
  // RSpec's summary is on stdout. Search both rather than assuming one.
  const combinedOutput = `${verification.stdout}\n${verification.stderr}`;
  const summary =
    combinedOutput.match(/^\d+ examples?, \d+ failures?.*$/m)?.[0] ??
    combinedOutput.match(/^Tests:.*$/m)?.[0] ??
    `${verifyCommand} exited ${verification.exitCode}`;

  return {
    converged: loopResult.converged,
    iterations: loopResult.iterations,
    testsPassed: verification.exitCode === 0,
    verifySummary: summary,
    verifyOutput: combinedOutput,
  };
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  fileTools: FileTools,
  dockerRunner: DockerRunner,
  projectDocsTools?: ProjectDocsTools,
): Promise<string> {
  try {
    switch (name) {
      case "read_project_doc":
        if (!projectDocsTools) return "Unknown tool: read_project_doc";
        return await projectDocsTools.read(String(args.path));
      case "write_project_doc":
        if (!projectDocsTools) return "Unknown tool: write_project_doc";
        await projectDocsTools.write(String(args.path), String(args.content ?? ""));
        return "ok";
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
