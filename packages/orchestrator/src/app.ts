import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import express, { type Express } from "express";
import { withUsageReporting, type ChatMessage, type LLMClient, type Usage } from "@app-builder/llm-client";
import {
  buildIncrementalSystemPrompt,
  buildSystemPrompt as buildIntakeSystemPrompt,
  runIntake,
  type ExistingProjectContext,
} from "@app-builder/intake-agent";
import {
  buildFeatureWorkflowInstructions,
  buildFrontendSystemPrompt,
  buildSystemPrompt as buildCodegenSystemPrompt,
  createDockerRunner,
  createFileTools,
  createProjectDocsTools,
  defaultFrontendMaxIterations,
  runCodegenAgent,
  runCodegenLoop,
  PROJECT_DOCS_TOOL_DEFINITIONS,
  type AgentEvent,
  type DockerRunner,
  type FeatureWorkflowContext,
  type FileTools,
  type ProjectDocsTools,
} from "@app-builder/codegen-agent";
import { runDebugAgent, type LiveComponent } from "@app-builder/debug-agent";
import { createRunAgent, type ComponentResult, type RunAgent } from "@app-builder/run-agent";
import { createInMemoryStore, type ChatSessionStore } from "./chatStore.js";
import {
  createInMemoryProjectStore,
  isProjectStage,
  type ProjectStore,
} from "./projectStore.js";
import { createInMemoryRunStore, type RunStore } from "./runStore.js";
import { loadScaffoldConfig, scaffoldProject } from "./scaffold.js";

export type Scaffold = (projectId: string) => Promise<string>;

const defaultScaffold: Scaffold = (projectId) =>
  scaffoldProject(projectId, loadScaffoldConfig());

const SYSTEM_PROMPT =
  "You are the chat assistant for an app-builder tool. If asked to " +
  "build, create, or generate an app, explain the flow in one or two " +
  "plain sentences, no hedging or explaining your reasoning out loud: " +
  "send a message starting with `/build` followed by a description — " +
  "e.g. `/build a task tracker with a title and due date` — which " +
  "proposes a plan (resources and screens) for review; reply `/proceed` " +
  "to actually build that plan, or send a new `/build` to try a " +
  "different one. Once it's written, your app starts running " +
  "automatically — `/run` reports the live URLs (or restarts it if it's " +
  "stopped) and `/stop` shuts it down without touching your code or " +
  "data. If something's wrong, `/debug` followed by a description " +
  "investigates and fixes it (or run it with no description for a " +
  "general health check). For everything else, just chat normally.";

const BUILD_PREFIX = "/build";
const PROCEED_COMMAND = "/proceed";
const RUN_COMMAND = "/run";
const STOP_COMMAND = "/stop";
const DEBUG_PREFIX = "/debug";

// Interim progress noise to keep out of Intake's context — see bug #17.
// Terminal outcomes ([build:done]/[build:failed]/[build:question]/
// [build:review], [run:live]/[run:failed], [debug:done]/[debug:failed],
// [stop:done]) are deliberately KEPT: a real "here's what happened last
// time" signal is useful, especially in a failure scenario, unlike the
// blow-by-blow tool-call narration in between.
const NOISY_PROGRESS_PATTERN = /^\[(build|debug)\]/;
const RUN_PENDING_PREFIX = "[run] Starting your app";

export function isNoisyProgressMessage(message: ChatMessage): boolean {
  return (
    message.role === "assistant" &&
    typeof message.content === "string" &&
    (NOISY_PROGRESS_PATTERN.test(message.content) || message.content.startsWith(RUN_PENDING_PREFIX))
  );
}

/**
 * What Intake sees of a project's prior chat, so a `/build` can reflect
 * something said in an earlier plain-chat turn instead of only the exact
 * text after `/build` — see docs/backlog.md bug #17.
 */
export function filterHistoryForIntake(history: ChatMessage[]): ChatMessage[] {
  return history.filter((message) => !isNoisyProgressMessage(message));
}

export type IntakeOutcome = { kind: "question" | "spec"; content: string };
export type CodegenOutcome =
  | { kind: "done"; content: string }
  | { kind: "failed"; content: string };

/**
 * A spec awaiting /proceed, plus the feature identity the whole run
 * (Intake through both Codegen phases) shares — see
 * docs/designs/intake-iteration.md.
 */
interface PendingBuild {
  spec: string;
  featureSlug: string;
  isIncremental: boolean;
}

const SCAFFOLD_STUB_MARKER = "Nothing built yet beyond the initial structural skeleton";

/**
 * Reality-based, not a stored pass/fail flag: reads the target project's
 * own docs/blueprints/features.md directly. Still the scaffold's stub
 * text → fresh (today's behavior); anything else → incremental,
 * regardless of whether the *last* build's final verification actually
 * passed — so a follow-up after a failed build still builds on whatever
 * was genuinely attempted, rather than risking a from-scratch rewrite.
 * See docs/designs/intake-iteration.md.
 */
export async function readExistingProjectContext(workspacePath: string): Promise<ExistingProjectContext | undefined> {
  const features = await readFile(path.join(workspacePath, "docs/blueprints/features.md"), "utf8").catch(() => "");
  if (!features || features.includes(SCAFFOLD_STUB_MARKER)) return undefined;

  const [architecture, backlog] = await Promise.all([
    readFile(path.join(workspacePath, "docs/blueprints/architecture.md"), "utf8").catch(() => ""),
    readFile(path.join(workspacePath, "docs/backlog.md"), "utf8").catch(() => ""),
  ]);
  return { features, architecture, backlog };
}

const FEATURE_TITLE_PATTERN = /^#\s+(.+)$/m;

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `feature-${Date.now()}`;
}

export function deriveFeatureSlug(intakeContent: string): string {
  const match = FEATURE_TITLE_PATTERN.exec(intakeContent);
  return match ? slugify(match[1]) : `feature-${Date.now()}`;
}

/**
 * Reported by the codegen phase once the frontend is written (backend
 * already verified passing) — the point at which the Run Agent starts
 * concurrently with final verification, not after it. See
 * docs/designs/run-deploy-agent.md.
 */
export type RunOutcome =
  | { kind: "pending" }
  | { kind: "live"; components: ComponentResult[] }
  | { kind: "failed"; error: string };

/**
 * Live, per-project LLM call status — powers the web UI's footer status
 * display (feature #14, amending #13). Ephemeral, in-memory only, same
 * lifetime as `buildingProjects` — not persisted across a restart.
 */
export interface ProgressSnapshot {
  agentLabel: string;
  totalSentTokens: number;
  totalReceivedTokens: number;
  /** epoch ms; null once the in-flight call's usage has been recorded (or before the first call). */
  callStartedAt: number | null;
}

export type RunIntakePhase = (params: {
  description: string;
  llmClient: LLMClient;
  /** Present once the target project already has real content — see readExistingProjectContext(). */
  existingContext?: ExistingProjectContext;
  /** Prior chat, pre-filtered via filterHistoryForIntake() — see bug #17. */
  history?: ChatMessage[];
  onCallStart: () => void;
  onUsage: (usage: Usage) => void;
}) => Promise<IntakeOutcome>;

export type RunCodegenPhase = (params: {
  workspacePath: string;
  buildSpec: string;
  /** kebab-case, shared by both phases — see docs/designs/intake-iteration.md. */
  featureSlug: string;
  isIncremental: boolean;
  llmClient: LLMClient;
  runAgent: RunAgent;
  onProgress: (content: string) => void;
  onRunOutcome: (outcome: RunOutcome) => void;
  onCallStart: () => void;
  onUsage: (usage: Usage) => void;
}) => Promise<CodegenOutcome>;

export type DebugOutcome =
  | { kind: "done"; content: string }
  | { kind: "failed"; content: string };

export type RunDebugPhase = (params: {
  workspacePath: string;
  /** No description means "do a general health check," not "nothing to look into." */
  description?: string;
  llmClient: LLMClient;
  liveComponents?: LiveComponent[];
  onProgress: (content: string) => void;
  onCallStart: () => void;
  onUsage: (usage: Usage) => void;
}) => Promise<DebugOutcome>;

function formatComponentList(components: ComponentResult[]): string {
  return components.map((c) => `${c.name}: ${c.url}`).join(", ");
}

/**
 * A one-line summary of a tool call, for chat progress — never the tool's
 * result (test output, file contents can be huge). Without this, the
 * chat log goes quiet the moment a model stops narrating turns in plain
 * text, which happens often once it's deep into a repetitive
 * fix-and-verify loop — the run is still working (see the token-usage
 * footer) but looks stalled. See docs/backlog.md bug #14.
 */
export function formatToolCall(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (name) {
    case "read_file":
    case "write_file":
    case "list_dir":
    case "list_files":
    case "read_project_doc":
    case "write_project_doc":
      return typeof a.path === "string" ? `→ ${name}: ${a.path}` : `→ ${name}`;
    case "search_files":
      return typeof a.pattern === "string" ? `→ search_files: "${a.pattern}"` : "→ search_files";
    case "run_command":
      return typeof a.command === "string" ? `→ run_command: ${a.command}` : "→ run_command";
    default:
      return `→ ${name}`;
  }
}

/**
 * A one-line summary of an empty turn (no text, no tool call) — a
 * genuine sign of life the caller would otherwise see nothing for. Names
 * the real finishReason so a future occurrence is diagnosable instead of
 * guessed at. See docs/backlog.md bug #15.
 */
export function formatEmptyTurn(finishReason: string): string {
  return finishReason === "length"
    ? "→ empty turn — ran out of token budget, nudging model to continue"
    : `→ empty turn (finishReason: ${finishReason}) — nudging model to continue`;
}

/** Thin wrapper around the Intake Agent — one fast LLM call, always awaited directly. */
export const defaultRunIntakePhase: RunIntakePhase = async ({
  description,
  llmClient,
  existingContext,
  history,
  onCallStart,
  onUsage,
}) => {
  const wrappedClient = withUsageReporting(llmClient, { onCallStart, onUsage });
  const systemPrompt = existingContext ? buildIncrementalSystemPrompt(existingContext) : buildIntakeSystemPrompt();
  const result = await runIntake({ llmClient: wrappedClient, systemPrompt, description, history });
  return { kind: result.kind, content: result.content };
};

/**
 * Safety net for docs/designs/intake-iteration.md's Feature workflow
 * step: that step only runs when the model reaches a natural stop
 * (converges, or gives up and says so in plain text) — but live testing
 * found a model can instead just run out of its iteration budget while
 * still actively fighting failures, never reaching that step at all, and
 * `docs/blueprints/features.md` is left at the scaffold's stub text with
 * no record of what was attempted. This is the single most important
 * case for that record to exist (see bug #16/feature #18's own
 * motivation: "where was it left at the end of a build"), so it's worth
 * a dedicated, bounded follow-up pass rather than an accepted gap. Also
 * covers the case where the model *thought* it converged but the
 * authoritative final test run disagreed — either way, the docs must
 * reflect the real, authoritative outcome, not what the model believed
 * mid-loop. Best-effort: a failure here doesn't change the build's own
 * reported outcome.
 */
async function runFeatureWorkflowEpilogue(params: {
  llmClient: LLMClient;
  buildSpec: string;
  outcomeSummary: string;
  fileTools: FileTools;
  dockerRunner: DockerRunner;
  projectDocsTools: ProjectDocsTools;
  featureWorkflow: FeatureWorkflowContext;
  onEvent: (event: AgentEvent) => void;
}): Promise<void> {
  const systemPrompt = [
    "This build attempt just ended without the main work loop reaching " +
      "a natural stop — it ran out of room, or its own belief that it " +
      "was done didn't match the authoritative final test run. Do NOT " +
      "attempt to fix or write any more application code. Your ONLY job " +
      "now is the step below — budget your remaining turns across all " +
      "four docs it names (design doc, backlog.md, features.md, " +
      "CHANGELOG.md); don't spend your whole budget perfecting the " +
      "first one and skip the rest.",
    buildFeatureWorkflowInstructions(params.featureWorkflow),
    `What was requested:\n\n${params.buildSpec}`,
    `What actually happened (the authoritative result — trust this over ` +
      `anything you may have believed mid-build):\n\n${params.outcomeSummary}`,
  ].join("\n\n");

  try {
    // Generous relative to the ~4 read+write pairs actually needed
    // (design doc, backlog, features, CHANGELOG) — these are cheap
    // doc-only calls, no Docker/test execution, so slack here is nearly
    // free. A tighter budget (6) was tried live and left 3 of the 4 docs
    // untouched — see docs/designs/intake-iteration.md.
    await runCodegenLoop({
      llmClient: params.llmClient,
      systemPrompt,
      buildSpec: params.buildSpec,
      fileTools: params.fileTools,
      dockerRunner: params.dockerRunner,
      projectDocsTools: params.projectDocsTools,
      toolDefinitions: PROJECT_DOCS_TOOL_DEFINITIONS,
      maxIterations: 14,
      onEvent: params.onEvent,
    });
  } catch {
    // Best-effort — the build's own outcome is reported regardless.
  }
}

/**
 * Real implementation: the Codegen Agent, backend then — if it passes —
 * frontend, chained in one run against the project's own scaffolded
 * workspace. See docs/designs/frontend-generation.md.
 */
export const defaultRunCodegenPhase: RunCodegenPhase = async ({
  workspacePath,
  buildSpec,
  featureSlug,
  isIncremental,
  llmClient,
  runAgent,
  onProgress,
  onRunOutcome,
  onCallStart,
  onUsage,
}) => {
  const forward = (event: AgentEvent) => {
    if (event.type === "assistant_message" && event.content) onProgress(event.content);
    if (event.type === "tool_call") onProgress(formatToolCall(event.name, event.args));
    if (event.type === "empty_turn") onProgress(formatEmptyTurn(event.finishReason));
  };
  // See docs/designs/token-usage-reporting.md.
  const wrappedClient = withUsageReporting(llmClient, { onCallStart, onUsage });
  // See docs/designs/intake-iteration.md — both phases share these so
  // whichever one runs last (or both, in an incremental run) leaves one
  // coherent record, not two conflicting ones.
  const featureWorkflow: FeatureWorkflowContext = { featureSlug, isIncremental };
  const projectDocsTools = createProjectDocsTools(workspacePath);

  const backendDocker = createDockerRunner(workspacePath, "rails");
  const frontendDocker = createDockerRunner(workspacePath, "frontend");
  const backendFileTools = createFileTools(path.join(workspacePath, "backend"));
  const frontendFileTools = createFileTools(path.join(workspacePath, "frontend"));
  // Only torn down if the Run Agent didn't leave a live instance behind —
  // see the `finally` block below.
  let instanceIsLive = false;

  try {
    const backendResult = await runCodegenAgent({
      llmClient: wrappedClient,
      systemPrompt: await buildCodegenSystemPrompt(undefined, featureWorkflow),
      buildSpec,
      fileTools: backendFileTools,
      dockerRunner: backendDocker,
      projectDocsTools,
      onEvent: forward,
    });

    if (!backendResult.testsPassed) {
      await runFeatureWorkflowEpilogue({
        llmClient: wrappedClient,
        buildSpec,
        outcomeSummary: `Backend build finished but tests did not pass after ${backendResult.iterations} iteration(s) (converged: ${backendResult.converged}): ${backendResult.verifySummary}`,
        fileTools: backendFileTools,
        dockerRunner: backendDocker,
        projectDocsTools,
        featureWorkflow,
        onEvent: forward,
      });
      return {
        kind: "failed",
        content: `Backend build finished but tests did not pass after ${backendResult.iterations} iteration(s): ${backendResult.verifySummary}`,
      };
    }

    onProgress(`Backend complete — ${backendResult.verifySummary}. Starting the frontend...`);

    // The loop (writes code) is split from the final verify command
    // (below) — once the app is written, verifying it and running it
    // happen at the same time, not one after the other. See
    // docs/designs/run-deploy-agent.md.
    const loopResult = await runCodegenLoop({
      llmClient: wrappedClient,
      systemPrompt: await buildFrontendSystemPrompt(undefined, featureWorkflow),
      buildSpec,
      fileTools: frontendFileTools,
      dockerRunner: frontendDocker,
      maxIterations: defaultFrontendMaxIterations(buildSpec),
      projectDocsTools,
      onEvent: forward,
    });

    onProgress("Frontend written — verifying and starting your app...");
    onRunOutcome({ kind: "pending" });

    const [verification, startResult] = await Promise.all([
      frontendDocker.run("npx jest"),
      runAgent.start({ workspacePath }),
    ]);

    if (startResult.status === "live") {
      instanceIsLive = true;
      onRunOutcome({ kind: "live", components: startResult.components });
    } else {
      onRunOutcome({ kind: "failed", error: startResult.error ?? "Unknown error starting your app." });
    }

    // Same stdout+stderr search as runCodegenAgent's own verify step —
    // duplicated here rather than reusing it because that helper also
    // owns running the command, and this command now runs concurrently
    // with the Run Agent's start(), not sequentially after the loop.
    const combinedOutput = `${verification.stdout}\n${verification.stderr}`;
    const verifySummary =
      combinedOutput.match(/^\d+ examples?, \d+ failures?.*$/m)?.[0] ??
      combinedOutput.match(/^Tests:.*$/m)?.[0] ??
      `npx jest exited ${verification.exitCode}`;

    if (verification.exitCode === 0) {
      return {
        kind: "done",
        content: `Build complete — backend: ${backendResult.verifySummary}; frontend: ${verifySummary}`,
      };
    }

    await runFeatureWorkflowEpilogue({
      llmClient: wrappedClient,
      buildSpec,
      outcomeSummary:
        `Backend: ${backendResult.verifySummary}. Frontend build finished but tests did not pass ` +
        `after ${loopResult.iterations} iteration(s) (converged: ${loopResult.converged}): ${verifySummary}`,
      fileTools: frontendFileTools,
      dockerRunner: frontendDocker,
      projectDocsTools,
      featureWorkflow,
      onEvent: forward,
    });
    return {
      kind: "failed",
      content: `Frontend build finished but tests did not pass after ${loopResult.iterations} iteration(s): ${verifySummary}`,
    };
  } catch (error) {
    return {
      kind: "failed",
      content: `Build failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    // docker compose down tears down the whole stack — but if the Run
    // Agent just brought the app up live, that's the opposite of what
    // should happen here. Only clean up the ephemeral dependency
    // containers a `run --rm` build leaves behind when nothing is
    // actually meant to stay running.
    if (!instanceIsLive) await backendDocker.down();
  }
};

/**
 * Real implementation: the Debug Agent, investigating and fixing an
 * already-built project — a reported problem, or a general sweep with no
 * description. See docs/designs/debug-agent.md.
 */
export const defaultRunDebugPhase: RunDebugPhase = async ({
  workspacePath,
  description,
  llmClient,
  liveComponents,
  onProgress,
  onCallStart,
  onUsage,
}) => {
  const forward = (event: AgentEvent) => {
    if (event.type === "assistant_message" && event.content) onProgress(event.content);
    if (event.type === "tool_call") onProgress(formatToolCall(event.name, event.args));
    if (event.type === "empty_turn") onProgress(formatEmptyTurn(event.finishReason));
  };
  // Both of Debug Agent's internal passes (backend, frontend) share this
  // client, so both accumulate into the same progress snapshot — see
  // docs/designs/token-usage-reporting.md.
  const wrappedClient = withUsageReporting(llmClient, { onCallStart, onUsage });

  try {
    const result = await runDebugAgent({
      llmClient: wrappedClient,
      workspacePath,
      description,
      liveComponents,
      onEvent: forward,
    });
    return result.fixed
      ? { kind: "done", content: `Debug complete — ${result.summary}` }
      : { kind: "failed", content: `Investigated, but tests still don't fully pass: ${result.summary}` };
  } catch (error) {
    return {
      kind: "failed",
      content: `Debug failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

export interface HealthInfo {
  baseUrl: string;
  model: string;
}

export function createApp(
  llmClient: LLMClient,
  healthInfo: HealthInfo,
  chatStore: ChatSessionStore = createInMemoryStore(),
  projectStore: ProjectStore = createInMemoryProjectStore(),
  scaffold: Scaffold = defaultScaffold,
  runIntakePhase: RunIntakePhase = defaultRunIntakePhase,
  runCodegenPhase: RunCodegenPhase = defaultRunCodegenPhase,
  runStore: RunStore = createInMemoryRunStore(),
  runAgent: RunAgent = createRunAgent(),
  runDebugPhase: RunDebugPhase = defaultRunDebugPhase,
): Express {
  const app = express();
  app.use(express.json());

  // Per-process only — a restart loses these, which also resets the
  // guard. See "Known, deliberate limitation" in
  // docs/designs/wire-agents-into-chat.md and docs/designs/frontend-generation.md.
  const buildingProjects = new Set<string>();
  const pendingSpecs = new Map<string, PendingBuild>();
  // Guards manual /run and /stop against racing each other or a build's
  // own automatic Run Agent trigger for the same project.
  const runningOps = new Set<string>();
  // Live per-project LLM call status, powering the web UI's footer status
  // display — reset at the start of each phase invocation, not persisted.
  // See docs/designs/token-usage-reporting.md's Amendment.
  const progressByProject = new Map<string, ProgressSnapshot>();

  function resetProgress(projectId: string, agentLabel: string) {
    progressByProject.set(projectId, {
      agentLabel,
      totalSentTokens: 0,
      totalReceivedTokens: 0,
      callStartedAt: null,
    });
  }

  function markCallStarted(projectId: string) {
    const prev = progressByProject.get(projectId);
    if (prev) progressByProject.set(projectId, { ...prev, callStartedAt: Date.now() });
  }

  function recordUsage(projectId: string, usage: Usage) {
    const prev = progressByProject.get(projectId);
    if (!prev) return;
    progressByProject.set(projectId, {
      ...prev,
      totalSentTokens: prev.totalSentTokens + usage.promptTokens,
      totalReceivedTokens: prev.totalReceivedTokens + usage.completionTokens,
      callStartedAt: null,
    });
  }

  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      glm: { baseUrl: healthInfo.baseUrl, model: healthInfo.model },
    });
  });

  app.get("/api/projects", async (_req, res) => {
    res.json({ projects: await projectStore.list() });
  });

  app.post("/api/projects", async (req, res) => {
    const { name } = req.body ?? {};
    if (typeof name !== "string" || name.trim().length === 0) {
      res
        .status(400)
        .json({ error: { code: "bad_request", message: "name is required" } });
      return;
    }

    const id = randomUUID();
    try {
      const workspacePath = await scaffold(id);
      const project = await projectStore.create({ id, name: name.trim(), workspacePath });
      res.status(201).json({ project });
    } catch (error) {
      res.status(500).json({
        error: {
          code: "scaffold_failed",
          message: error instanceof Error ? error.message : "Failed to scaffold project",
        },
      });
    }
  });

  app.patch("/api/projects/:id/stage", async (req, res) => {
    const { stage } = req.body ?? {};
    if (!isProjectStage(stage)) {
      res
        .status(400)
        .json({ error: { code: "bad_request", message: "stage is invalid" } });
      return;
    }
    const project = await projectStore.updateStage(req.params.id, stage);
    if (!project) {
      res
        .status(404)
        .json({ error: { code: "not_found", message: "project not found" } });
      return;
    }
    res.json({ project });
  });

  app.get("/api/projects/:id/messages", async (req, res) => {
    const project = await projectStore.get(req.params.id);
    if (!project) {
      res
        .status(404)
        .json({ error: { code: "not_found", message: "project not found" } });
      return;
    }
    res.json({ messages: await chatStore.get(req.params.id) });
  });

  app.get("/api/projects/:id/progress", async (req, res) => {
    const project = await projectStore.get(req.params.id);
    if (!project) {
      res
        .status(404)
        .json({ error: { code: "not_found", message: "project not found" } });
      return;
    }
    res.json({ progress: progressByProject.get(req.params.id) ?? null });
  });

  app.post("/api/chat", async (req, res) => {
    const { projectId, message } = req.body ?? {};

    if (typeof projectId !== "string" || projectId.length === 0) {
      res
        .status(400)
        .json({ error: { code: "bad_request", message: "projectId is required" } });
      return;
    }
    const project = await projectStore.get(projectId);
    if (!project) {
      res
        .status(404)
        .json({ error: { code: "not_found", message: "project not found" } });
      return;
    }
    if (typeof message !== "string" || message.trim().length === 0) {
      res
        .status(400)
        .json({ error: { code: "bad_request", message: "message is required" } });
      return;
    }

    const userMessage: ChatMessage = { role: "user", content: message };
    const trimmed = message.trim();

    if (trimmed === BUILD_PREFIX || trimmed.startsWith(`${BUILD_PREFIX} `)) {
      if (buildingProjects.has(projectId)) {
        const notice: ChatMessage = {
          role: "assistant",
          content: "[build] A build is already running for this project — please wait for it to finish.",
        };
        await chatStore.append(projectId, [userMessage, notice]);
        res.json({ reply: notice.content, finishReason: "stop" });
        return;
      }

      const description = trimmed.slice(BUILD_PREFIX.length).trim();
      if (!description) {
        // Tagged as a terminal [build:question], not plain [build]: no run
        // was started, so the client must not start polling for progress
        // that's never coming.
        const notice: ChatMessage = {
          role: "assistant",
          content:
            "[build:question] Please describe what to build after /build, e.g. " +
            "`/build a task tracker with a title and due date`.",
        };
        await chatStore.append(projectId, [userMessage, notice]);
        res.json({ reply: notice.content, finishReason: "stop" });
        return;
      }

      // Awaited directly — one fast LLM call, no reason to make the user
      // wait on a fire-and-forget promise for this part. See
      // docs/designs/frontend-generation.md.
      try {
        resetProgress(projectId, "Intake Agent");
        // Reality-based, not a stored flag — see readExistingProjectContext().
        const existingContext = await readExistingProjectContext(project.workspacePath);
        // Not yet including this /build message itself — that's added
        // below alongside the reply. See bug #17.
        const history = filterHistoryForIntake(await chatStore.get(projectId));
        const intakeResult = await runIntakePhase({
          description,
          llmClient,
          existingContext,
          history,
          onCallStart: () => markCallStarted(projectId),
          onUsage: (usage) => recordUsage(projectId, usage),
        });
        const reply: ChatMessage =
          intakeResult.kind === "question"
            ? { role: "assistant", content: `[build:question] ${intakeResult.content}` }
            : {
                role: "assistant",
                content:
                  "[build:review] Proposed plan — reply /proceed to build it, or send a new " +
                  `/build <description> to try again:\n\n${intakeResult.content}`,
              };

        if (intakeResult.kind === "spec") {
          pendingSpecs.set(projectId, {
            spec: intakeResult.content,
            featureSlug: deriveFeatureSlug(intakeResult.content),
            isIncremental: existingContext !== undefined,
          });
        }

        await chatStore.append(projectId, [userMessage, reply]);
        res.json({ reply: reply.content, finishReason: "stop" });
      } catch (error) {
        await chatStore.append(projectId, [userMessage]);
        res.status(502).json({
          error: {
            code: "llm_error",
            message: error instanceof Error ? error.message : "Unknown LLM error",
          },
        });
      }
      return;
    }

    if (trimmed === PROCEED_COMMAND) {
      if (buildingProjects.has(projectId)) {
        const notice: ChatMessage = {
          role: "assistant",
          content: "[build] A build is already running for this project — please wait for it to finish.",
        };
        await chatStore.append(projectId, [userMessage, notice]);
        res.json({ reply: notice.content, finishReason: "stop" });
        return;
      }

      const pending = pendingSpecs.get(projectId);
      if (!pending) {
        // No [build...] tag — nothing is going to run, so the client
        // must not start polling.
        const notice: ChatMessage = {
          role: "assistant",
          content: "Nothing is pending review for this project — send /build <description> first.",
        };
        await chatStore.append(projectId, [userMessage, notice]);
        res.json({ reply: notice.content, finishReason: "stop" });
        return;
      }
      pendingSpecs.delete(projectId);

      const ack: ChatMessage = {
        role: "assistant",
        content: "[build] Got it — starting the build. This can take several minutes.",
      };
      await chatStore.append(projectId, [userMessage, ack]);
      res.json({ reply: ack.content, finishReason: "stop" });

      buildingProjects.add(projectId);
      resetProgress(projectId, "Codegen Agent");
      runCodegenPhase({
        workspacePath: project.workspacePath,
        buildSpec: pending.spec,
        featureSlug: pending.featureSlug,
        isIncremental: pending.isIncremental,
        llmClient,
        runAgent,
        onProgress: (content) => {
          chatStore.append(projectId, [{ role: "assistant", content: `[build] ${content}` }]).catch(() => {});
        },
        onCallStart: () => markCallStarted(projectId),
        onUsage: (usage) => recordUsage(projectId, usage),
        onRunOutcome: (outcome) => {
          if (outcome.kind === "pending") {
            runStore.setStatus(projectId, "starting").catch(() => {});
            chatStore.append(projectId, [{ role: "assistant", content: "[run] Starting your app..." }]).catch(() => {});
          } else if (outcome.kind === "live") {
            runStore.setLive(projectId, outcome.components).catch(() => {});
            chatStore
              .append(projectId, [
                { role: "assistant", content: `[run:live] Your app is running — ${formatComponentList(outcome.components)}` },
              ])
              .catch(() => {});
          } else {
            runStore.setStatus(projectId, "failed", outcome.error).catch(() => {});
            chatStore.append(projectId, [{ role: "assistant", content: `[run:failed] ${outcome.error}` }]).catch(() => {});
          }
        },
      })
        .then((outcome) =>
          chatStore.append(projectId, [
            { role: "assistant", content: `[build:${outcome.kind}] ${outcome.content}` },
          ]),
        )
        .catch((error) =>
          chatStore.append(projectId, [
            {
              role: "assistant",
              content: `[build:failed] Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ]),
        )
        .finally(() => buildingProjects.delete(projectId));

      return;
    }

    if (trimmed === RUN_COMMAND) {
      if (buildingProjects.has(projectId)) {
        const notice: ChatMessage = {
          role: "assistant",
          content: "[run] A build is in progress — your app will start automatically once it's ready.",
        };
        await chatStore.append(projectId, [userMessage, notice]);
        res.json({ reply: notice.content, finishReason: "stop" });
        return;
      }
      if (runningOps.has(projectId)) {
        const notice: ChatMessage = {
          role: "assistant",
          content: "[run] Already working on this — please wait.",
        };
        await chatStore.append(projectId, [userMessage, notice]);
        res.json({ reply: notice.content, finishReason: "stop" });
        return;
      }

      const existing = await runStore.get(projectId);
      if (existing?.status === "live") {
        const notice: ChatMessage = {
          role: "assistant",
          content: `[run:live] Already running — ${formatComponentList(existing.components)}`,
        };
        await chatStore.append(projectId, [userMessage, notice]);
        res.json({ reply: notice.content, finishReason: "stop" });
        return;
      }
      if (existing?.status === "starting") {
        const notice: ChatMessage = { role: "assistant", content: "[run] Still starting — please wait." };
        await chatStore.append(projectId, [userMessage, notice]);
        res.json({ reply: notice.content, finishReason: "stop" });
        return;
      }

      const ack: ChatMessage = { role: "assistant", content: "[run] Starting your app..." };
      await chatStore.append(projectId, [userMessage, ack]);
      res.json({ reply: ack.content, finishReason: "stop" });

      runningOps.add(projectId);
      runStore.setStatus(projectId, "starting").catch(() => {});
      runAgent
        .start({ workspacePath: project.workspacePath })
        .then((result) => {
          if (result.status === "live") {
            return runStore.setLive(projectId, result.components).then(() =>
              chatStore.append(projectId, [
                { role: "assistant", content: `[run:live] Your app is running — ${formatComponentList(result.components)}` },
              ]),
            );
          }
          return runStore
            .setStatus(projectId, "failed", result.error)
            .then(() => chatStore.append(projectId, [{ role: "assistant", content: `[run:failed] ${result.error}` }]));
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          return runStore
            .setStatus(projectId, "failed", message)
            .then(() =>
              chatStore.append(projectId, [{ role: "assistant", content: `[run:failed] Unexpected error: ${message}` }]),
            );
        })
        .finally(() => runningOps.delete(projectId));

      return;
    }

    if (trimmed === STOP_COMMAND) {
      if (buildingProjects.has(projectId) || runningOps.has(projectId)) {
        const notice: ChatMessage = {
          role: "assistant",
          content: "Already working on this project — please wait, then try /stop again.",
        };
        await chatStore.append(projectId, [userMessage, notice]);
        res.json({ reply: notice.content, finishReason: "stop" });
        return;
      }

      const existing = await runStore.get(projectId);
      if (!existing || existing.status !== "live") {
        const notice: ChatMessage = { role: "assistant", content: "Nothing is running for this project." };
        await chatStore.append(projectId, [userMessage, notice]);
        res.json({ reply: notice.content, finishReason: "stop" });
        return;
      }

      runningOps.add(projectId);
      try {
        await runAgent.stop({ workspacePath: project.workspacePath });
        await runStore.setStatus(projectId, "stopped");
        const notice: ChatMessage = {
          role: "assistant",
          content: "[stop:done] Stopped — your data and code are untouched.",
        };
        await chatStore.append(projectId, [userMessage, notice]);
        res.json({ reply: notice.content, finishReason: "stop" });
      } finally {
        runningOps.delete(projectId);
      }
      return;
    }

    if (trimmed === DEBUG_PREFIX || trimmed.startsWith(`${DEBUG_PREFIX} `)) {
      if (buildingProjects.has(projectId) || runningOps.has(projectId)) {
        const notice: ChatMessage = {
          role: "assistant",
          content: "[debug] Already working on this project — please wait, then try /debug again.",
        };
        await chatStore.append(projectId, [userMessage, notice]);
        res.json({ reply: notice.content, finishReason: "stop" });
        return;
      }

      // No description means "do a general health check," not "nothing
      // to investigate" — unlike /build, an empty /debug is a valid,
      // meaningful request on its own.
      const description = trimmed.slice(DEBUG_PREFIX.length).trim() || undefined;

      const ack: ChatMessage = {
        role: "assistant",
        content: "[debug] Got it — looking into this. This can take a few minutes.",
      };
      await chatStore.append(projectId, [userMessage, ack]);
      res.json({ reply: ack.content, finishReason: "stop" });

      buildingProjects.add(projectId);
      resetProgress(projectId, "Debug Agent");
      const liveInstance = await runStore.get(projectId);
      const liveComponents = liveInstance?.status === "live" ? liveInstance.components : undefined;

      runDebugPhase({
        workspacePath: project.workspacePath,
        description,
        llmClient,
        liveComponents,
        onProgress: (content) => {
          chatStore.append(projectId, [{ role: "assistant", content: `[debug] ${content}` }]).catch(() => {});
        },
        onCallStart: () => markCallStarted(projectId),
        onUsage: (usage) => recordUsage(projectId, usage),
      })
        .then((outcome) =>
          chatStore.append(projectId, [
            { role: "assistant", content: `[debug:${outcome.kind}] ${outcome.content}` },
          ]),
        )
        .catch((error) =>
          chatStore.append(projectId, [
            {
              role: "assistant",
              content: `[debug:failed] Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ]),
        )
        .finally(() => buildingProjects.delete(projectId));

      return;
    }

    const history = await chatStore.get(projectId);

    try {
      const result = await llmClient.chat({
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history, userMessage],
      });
      await chatStore.append(projectId, [userMessage, result.message]);
      res.json({ reply: result.message.content, finishReason: result.finishReason });
    } catch (error) {
      res.status(502).json({
        error: {
          code: "llm_error",
          message: error instanceof Error ? error.message : "Unknown LLM error",
        },
      });
    }
  });

  return app;
}
