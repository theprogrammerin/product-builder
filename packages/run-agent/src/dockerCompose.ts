import { spawn } from "node:child_process";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs `docker compose <args>` rooted at workspaceRoot's docker-compose.yml.
 * Distinct from codegen-agent's dockerExec.ts, which runs one-off `run
 * --rm` commands for the agentic coding loop — this runs long-lived
 * lifecycle commands (`up -d`, `stop`) for the Run Agent instead. See
 * docs/designs/run-deploy-agent.md.
 */
export function runDockerCompose(
  workspaceRoot: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["compose", ...args], {
      cwd: workspaceRoot,
      env: { ...process.env, ...env },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode: exitCode ?? -1, stdout, stderr }));
  });
}
