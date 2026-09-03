import { randomUUID } from "node:crypto";
import path from "node:path";
import express, { type Express } from "express";
import type { ChatMessage, LLMClient } from "@app-builder/llm-client";
import {
  buildSystemPrompt as buildIntakeSystemPrompt,
  runIntake,
} from "@app-builder/intake-agent";
import {
  buildFrontendSystemPrompt,
  buildSystemPrompt as buildCodegenSystemPrompt,
  createDockerRunner,
  createFileTools,
  defaultFrontendMaxIterations,
  runCodegenAgent,
  type AgentEvent,
} from "@app-builder/codegen-agent";
import { createInMemoryStore, type ChatSessionStore } from "./chatStore.js";
import {
  createInMemoryProjectStore,
  isProjectStage,
  type ProjectStore,
} from "./projectStore.js";
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
  "different one. For everything else, just chat normally.";

const BUILD_PREFIX = "/build";
const PROCEED_COMMAND = "/proceed";

export type IntakeOutcome = { kind: "question" | "spec"; content: string };
export type CodegenOutcome =
  | { kind: "done"; content: string }
  | { kind: "failed"; content: string };

export type RunIntakePhase = (params: {
  description: string;
  llmClient: LLMClient;
}) => Promise<IntakeOutcome>;

export type RunCodegenPhase = (params: {
  workspacePath: string;
  buildSpec: string;
  llmClient: LLMClient;
  onProgress: (content: string) => void;
}) => Promise<CodegenOutcome>;

/** Thin wrapper around the Intake Agent — one fast LLM call, always awaited directly. */
export const defaultRunIntakePhase: RunIntakePhase = async ({ description, llmClient }) => {
  const result = await runIntake({ llmClient, systemPrompt: buildIntakeSystemPrompt(), description });
  return { kind: result.kind, content: result.content };
};

/**
 * Real implementation: the Codegen Agent, backend then — if it passes —
 * frontend, chained in one run against the project's own scaffolded
 * workspace. See docs/designs/frontend-generation.md.
 */
export const defaultRunCodegenPhase: RunCodegenPhase = async ({
  workspacePath,
  buildSpec,
  llmClient,
  onProgress,
}) => {
  const forward = (event: AgentEvent) => {
    if (event.type === "assistant_message" && event.content) onProgress(event.content);
  };

  const backendDocker = createDockerRunner(workspacePath, "rails");
  const frontendDocker = createDockerRunner(workspacePath, "frontend");

  try {
    const backendResult = await runCodegenAgent({
      llmClient,
      systemPrompt: await buildCodegenSystemPrompt(),
      buildSpec,
      fileTools: createFileTools(path.join(workspacePath, "backend")),
      dockerRunner: backendDocker,
      onEvent: forward,
    });

    if (!backendResult.testsPassed) {
      return {
        kind: "failed",
        content: `Backend build finished but tests did not pass after ${backendResult.iterations} iteration(s): ${backendResult.verifySummary}`,
      };
    }

    onProgress(`Backend complete — ${backendResult.verifySummary}. Starting the frontend...`);

    const frontendResult = await runCodegenAgent({
      llmClient,
      systemPrompt: await buildFrontendSystemPrompt(),
      buildSpec,
      fileTools: createFileTools(path.join(workspacePath, "frontend")),
      dockerRunner: frontendDocker,
      maxIterations: defaultFrontendMaxIterations(buildSpec),
      verifyCommand: "npx jest",
      onEvent: forward,
    });

    return frontendResult.testsPassed
      ? {
          kind: "done",
          content: `Build complete — backend: ${backendResult.verifySummary}; frontend: ${frontendResult.verifySummary}`,
        }
      : {
          kind: "failed",
          content: `Frontend build finished but tests did not pass after ${frontendResult.iterations} iteration(s): ${frontendResult.verifySummary}`,
        };
  } catch (error) {
    return {
      kind: "failed",
      content: `Build failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    // docker compose down tears down the whole stack (both services) —
    // one call covers it regardless of which runner it's called on.
    await backendDocker.down();
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
): Express {
  const app = express();
  app.use(express.json());

  // Per-process only — a restart loses these, which also resets the
  // guard. See "Known, deliberate limitation" in
  // docs/designs/wire-agents-into-chat.md and docs/designs/frontend-generation.md.
  const buildingProjects = new Set<string>();
  const pendingSpecs = new Map<string, string>();

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
        const intakeResult = await runIntakePhase({ description, llmClient });
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
          pendingSpecs.set(projectId, intakeResult.content);
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

      const buildSpec = pendingSpecs.get(projectId);
      if (!buildSpec) {
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
      runCodegenPhase({
        workspacePath: project.workspacePath,
        buildSpec,
        llmClient,
        onProgress: (content) => {
          chatStore.append(projectId, [{ role: "assistant", content: `[build] ${content}` }]).catch(() => {});
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
