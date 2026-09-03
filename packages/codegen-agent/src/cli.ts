#!/usr/bin/env node
import "dotenv/config";
import path from "node:path";
import { GlmClient, loadGlmConfig } from "@app-builder/llm-client";
import { runCodegenAgent } from "./agent.js";
import { createDockerRunner } from "./dockerExec.js";
import { buildSystemPrompt, loadBuildSpec } from "./promptContext.js";
import { createFileTools } from "./tools.js";

function parseArgs(argv: string[]): { workspace: string; spec: string } {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    const value = argv[i + 1];
    if (key && value) args[key] = value;
  }
  if (!args.workspace || !args.spec) {
    throw new Error("Usage: codegen-agent --workspace <path-to-scaffolded-project> --spec <path-to-build-spec.md>");
  }
  return { workspace: args.workspace, spec: args.spec };
}

async function main() {
  const { workspace, spec } = parseArgs(process.argv.slice(2));
  const workspaceRoot = path.resolve(workspace);
  const backendRoot = path.join(workspaceRoot, "backend");
  const specPath = path.resolve(spec);

  const config = loadGlmConfig();
  const llmClient = new GlmClient(config);
  const systemPrompt = await buildSystemPrompt();
  const buildSpec = await loadBuildSpec(specPath);
  const fileTools = createFileTools(backendRoot);
  const dockerRunner = createDockerRunner(workspaceRoot);

  console.log(`Running Codegen Agent on ${workspaceRoot} using spec ${specPath}...`);

  try {
    const result = await runCodegenAgent({
      llmClient,
      systemPrompt,
      buildSpec,
      fileTools,
      dockerRunner,
      onEvent: (event) => {
        if (event.type === "assistant_message") {
          if (event.content) console.log(`\n[assistant] ${event.content}`);
        } else if (event.type === "tool_call") {
          console.log(`\n[tool_call] ${event.name}(${JSON.stringify(event.args)})`);
        } else if (event.type === "tool_result") {
          console.log(`[tool_result] ${event.result.slice(0, 800)}`);
        }
      },
    });

    console.log(
      `\n${result.converged ? "Model signaled done" : "Hit max iterations"} after ${result.iterations} iteration(s).`,
    );
    console.log("Final verification (bundle exec rspec):");
    console.log(result.verifyOutput);

    if (result.testsPassed) {
      console.log(`PASS — ${result.verifySummary}`);
    } else {
      console.log(`FAIL — ${result.verifySummary}`);
      process.exitCode = 1;
    }
  } finally {
    // Tear down mysql/mongo/redis so they don't linger holding resources
    // (or, before the docker-compose.yml port-publishing fix, host ports)
    // for the next CLI run. See docs/designs/codegen-agent-milestone-1.md.
    console.log("\nStopping project containers (docker compose down)...");
    await dockerRunner.down();
  }
}

main().catch((error) => {
  console.error("Codegen Agent failed:", error);
  process.exitCode = 1;
});
