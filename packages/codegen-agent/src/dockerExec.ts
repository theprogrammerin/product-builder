import { spawn } from "node:child_process";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DockerRunner {
  run(command: string): Promise<CommandResult>;
  /** Tears down this project's dependency containers (mysql/mongo/redis) so they don't linger between CLI runs. */
  down(): Promise<CommandResult>;
}

/**
 * Runs a one-off command inside a fresh container for the given
 * docker-compose service (default: "rails"), rooted at workspaceRoot's
 * docker-compose.yml. Uses `run --rm`, not `up` — the rails service's own
 * CMD expects a bundled, working app that doesn't exist yet at the start
 * of a codegen run, and would just crash-loop under `up`. `run` starts a
 * fresh one-off container per command, which is what an iterative build
 * loop needs. See docs/designs/codegen-agent-milestone-1.md.
 */
function runDockerCompose(workspaceRoot: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["compose", ...args], { cwd: workspaceRoot });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode: exitCode ?? -1, stdout, stderr }));
  });
}

export function createDockerRunner(workspaceRoot: string, service = "rails"): DockerRunner {
  return {
    run(command) {
      // -T: no pseudo-TTY, since this output is parsed/read, not watched
      // live — standard hygiene for non-interactive command execution.
      // On its own this did NOT stop Jest from colorizing its summary
      // (neither did CI=true alone) — that needed FORCE_COLOR=0 set on
      // the frontend service in docker-compose.yml, which chalk/
      // supports-color (what Jest uses internally) honors
      // unconditionally. See docs/designs/frontend-generation.md.
      return runDockerCompose(workspaceRoot, ["run", "--rm", "-T", service, "bash", "-lc", command]);
    },
    down() {
      return runDockerCompose(workspaceRoot, ["down"]);
    },
  };
}
