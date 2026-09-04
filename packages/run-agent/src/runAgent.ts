import { loadComposeInfo, type ComponentSpec } from "./composeInfo.js";
import { runDockerCompose, type CommandResult } from "./dockerCompose.js";
import { findFreePort } from "./portAllocator.js";
import { waitForHealthy } from "./healthCheck.js";

export interface ComponentResult {
  name: string;
  port: number;
  url: string;
}

export interface StartResult {
  status: "live" | "failed";
  /** Empty on failure. */
  components: ComponentResult[];
  error?: string;
}

export interface RunAgent {
  start(params: { workspacePath: string }): Promise<StartResult>;
  stop(params: { workspacePath: string }): Promise<void>;
}

export interface RunAgentDeps {
  loadComposeInfo: typeof loadComposeInfo;
  runDockerCompose: typeof runDockerCompose;
  findFreePort: typeof findFreePort;
  waitForHealthy: typeof waitForHealthy;
  healthCheckOptions?: { timeoutMs?: number; intervalMs?: number };
}

const defaultDeps: RunAgentDeps = {
  loadComposeInfo,
  runDockerCompose,
  findFreePort,
  waitForHealthy,
};

function failed(error: string): StartResult {
  return { status: "failed", components: [], error };
}

function describeCommandFailure(label: string, result: CommandResult): string {
  return `${label} failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).trim().slice(-500)}`;
}

/**
 * Given a project's own docker-compose.yml, discovers which services are
 * exposable (see composeInfo.ts), allocates each a free host port, brings
 * the whole stack up, migrates the database if a `rails` component is
 * present, and health-checks every exposed URL. See
 * docs/designs/run-deploy-agent.md for the full design.
 */
export function createRunAgent(deps: Partial<RunAgentDeps> = {}): RunAgent {
  const d = { ...defaultDeps, ...deps };

  return {
    async start({ workspacePath }) {
      let components: ComponentSpec[];
      let serviceNames: string[];
      try {
        const info = await d.loadComposeInfo(workspacePath);
        components = info.components;
        serviceNames = info.serviceNames;
      } catch (error) {
        return failed(`Could not read docker-compose.yml: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (components.length === 0) {
        return failed("No exposable components found in docker-compose.yml (no service declares a ${..._HOST_PORT} port).");
      }

      const ports = new Map<string, number>();
      for (const component of components) {
        ports.set(component.name, await d.findFreePort());
      }

      const dependencyServices = serviceNames.filter(
        (name) => !components.some((c) => c.name === name),
      );

      if (dependencyServices.length > 0) {
        const upDeps = await d.runDockerCompose(workspacePath, ["up", "-d", ...dependencyServices]);
        if (upDeps.exitCode !== 0) return failed(describeCommandFailure("docker compose up (dependencies)", upDeps));
      }

      const railsComponent = components.find((c) => c.name === "rails");
      if (railsComponent) {
        const migrate = await d.runDockerCompose(workspacePath, [
          "run",
          "--rm",
          "-T",
          "rails",
          "bash",
          "-lc",
          "bin/rails db:create db:migrate",
        ]);
        if (migrate.exitCode !== 0) return failed(describeCommandFailure("Database migration", migrate));
      }

      // Every component's URL is made available to every other one —
      // not just its own port — so any service's environment: block can
      // reference `${<NAME>_URL}` for whichever other component it needs
      // to reach, regardless of which of those services it itself is.
      // See docs/designs/component-networking.md.
      const componentEnv: Record<string, string> = {};
      for (const component of components) {
        const port = ports.get(component.name)!;
        componentEnv[component.envVar] = String(port);
        componentEnv[`${component.name.toUpperCase()}_URL`] = `http://localhost:${port}`;
      }

      const upComponents = await d.runDockerCompose(
        workspacePath,
        ["up", "-d", ...components.map((c) => c.name)],
        componentEnv,
      );
      if (upComponents.exitCode !== 0) return failed(describeCommandFailure("docker compose up (components)", upComponents));

      const results: ComponentResult[] = components.map((component) => ({
        name: component.name,
        port: ports.get(component.name)!,
        url: `http://localhost:${ports.get(component.name)}`,
      }));

      const healthChecks = await Promise.all(
        results.map((component) => d.waitForHealthy(component.url, d.healthCheckOptions)),
      );
      const unhealthy = results.filter((_, index) => !healthChecks[index]);
      if (unhealthy.length > 0) {
        return failed(
          `Timed out waiting for: ${unhealthy.map((c) => `${c.name} (${c.url})`).join(", ")}. The containers are running — check their logs.`,
        );
      }

      return { status: "live", components: results };
    },

    async stop({ workspacePath }) {
      // No service arguments: stops every service in the stack. Not
      // `down` — named volumes, the network, and data all survive a
      // `stop`, so a follow-up start doesn't need to re-run migrations
      // against an empty database.
      await d.runDockerCompose(workspacePath, ["stop"]);
    },
  };
}
