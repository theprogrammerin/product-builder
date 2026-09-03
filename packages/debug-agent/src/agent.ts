import type { LLMClient } from "@app-builder/llm-client";
import {
  createDockerRunner,
  createFileTools,
  runCodegenLoop,
  type AgentEvent,
  type CommandResult,
} from "@app-builder/codegen-agent";
import { assembleInitialContext, type LiveComponent } from "./context.js";
import { buildDebugSystemPrompt } from "./promptContext.js";
import { buildDebugToolDefinitions } from "./toolDefinitions.js";

export type { LiveComponent } from "./context.js";

export interface DebugResult {
  fixed: boolean;
  /** e.g. "Backend: 19 examples, 0 failures; Frontend: Tests: 12 passed, 12 total" */
  summary: string;
}

export interface RunDebugAgentOptions {
  llmClient: LLMClient;
  workspacePath: string;
  /** No description means "do a general health check," not "nothing to look into." */
  description?: string;
  /** Present only if the Run Agent has a live instance for this project — see docs/designs/debug-agent.md. */
  liveComponents?: LiveComponent[];
  onEvent?: (event: AgentEvent) => void;
}

/** Injectable seam for tests — mirrors @app-builder/run-agent's createRunAgent(deps) pattern. */
export interface RunDebugAgentDeps {
  createDockerRunner: typeof createDockerRunner;
  createFileTools: typeof createFileTools;
  runCodegenLoop: typeof runCodegenLoop;
  assembleInitialContext: typeof assembleInitialContext;
}

const defaultDeps: RunDebugAgentDeps = {
  createDockerRunner,
  createFileTools,
  runCodegenLoop,
  assembleInitialContext,
};

function summarizeFinal(command: string, result: CommandResult): { summary: string; passed: boolean } {
  const combined = `${result.stdout}\n${result.stderr}`;
  const summary =
    combined.match(/^\d+ examples?, \d+ failures?.*$/m)?.[0] ??
    combined.match(/^Tests:.*$/m)?.[0] ??
    `${command} exited ${result.exitCode}`;
  return { summary, passed: result.exitCode === 0 };
}

/**
 * Investigates an already-built project — a reported problem, or a
 * general sweep with no description — and fixes what it finds, in two
 * scoped passes (backend, then frontend) sharing the same diagnostic
 * context, reusing the Codegen Agent's tool-calling loop rather than
 * duplicating it. Re-verifies both sides for real before reporting
 * success, regardless of which pass(es) changed anything. See
 * docs/designs/debug-agent.md.
 */
export async function runDebugAgent(
  options: RunDebugAgentOptions,
  deps: Partial<RunDebugAgentDeps> = {},
): Promise<DebugResult> {
  const d = { ...defaultDeps, ...deps };
  const { llmClient, workspacePath, description, liveComponents, onEvent } = options;
  const backendDocker = d.createDockerRunner(workspacePath, "rails");
  const frontendDocker = d.createDockerRunner(workspacePath, "frontend");
  // The whole project is the sandbox root (not backend/ or frontend/
  // individually) so both passes can reach CLAUDE.md/docs/backlog.md —
  // see toolDefinitions.ts for why the tool descriptions differ from
  // codegen-agent's.
  const fileTools = d.createFileTools(workspacePath);
  const isLive = !!liveComponents && liveComponents.length > 0;

  try {
    const { contextText } = await d.assembleInitialContext({
      description,
      backendDocker,
      frontendDocker,
      workspacePath,
      liveComponents,
    });

    await d.runCodegenLoop({
      llmClient,
      systemPrompt: await buildDebugSystemPrompt("backend"),
      buildSpec: contextText,
      fileTools,
      dockerRunner: backendDocker,
      toolDefinitions: buildDebugToolDefinitions("backend"),
      onEvent,
    });

    await d.runCodegenLoop({
      llmClient,
      systemPrompt: await buildDebugSystemPrompt("frontend"),
      buildSpec: contextText,
      fileTools,
      dockerRunner: frontendDocker,
      toolDefinitions: buildDebugToolDefinitions("frontend"),
      onEvent,
    });

    const [backendVerify, frontendVerify] = await Promise.all([
      backendDocker.run("bundle exec rspec"),
      frontendDocker.run("npx jest"),
    ]);
    const backend = summarizeFinal("bundle exec rspec", backendVerify);
    const frontend = summarizeFinal("npx jest", frontendVerify);

    return {
      fixed: backend.passed && frontend.passed,
      summary: `Backend: ${backend.summary}; Frontend: ${frontend.summary}`,
    };
  } finally {
    // Never tear down containers the Run Agent is actively keeping live
    // for this project — same rule runCodegenPhase follows in the
    // orchestrator. See docs/designs/run-deploy-agent.md.
    if (!isLive) await backendDocker.down();
  }
}
