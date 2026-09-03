import type { CommandResult, DockerRunner } from "@app-builder/codegen-agent";
import { runDockerCompose } from "@app-builder/run-agent";

export interface LiveComponent {
  name: string;
  url: string;
}

interface VerificationSummary {
  summary: string;
  passed: boolean;
}

/**
 * Same combined-stdout+stderr summary search as codegen-agent's
 * runCodegenAgent — duplicated, not imported: that logic isn't exported
 * as a standalone function there, and debug-agent deliberately only
 * depends on codegen-agent's public API. See docs/designs/debug-agent.md.
 */
function summarizeVerification(command: string, result: CommandResult): VerificationSummary {
  const combined = `${result.stdout}\n${result.stderr}`;
  const summary =
    combined.match(/^\d+ examples?, \d+ failures?.*$/m)?.[0] ??
    combined.match(/^Tests:.*$/m)?.[0] ??
    `${command} exited ${result.exitCode}`;
  return { summary, passed: result.exitCode === 0 };
}

async function fetchLiveLogs(workspacePath: string, components: LiveComponent[]): Promise<string> {
  const sections = await Promise.all(
    components.map(async (component) => {
      const result = await runDockerCompose(workspacePath, ["logs", "--tail=200", component.name]);
      const output = `${result.stdout}${result.stderr}`.trim() || "(no output)";
      return `### ${component.name} (recent logs)\n\n\`\`\`\n${output}\n\`\`\``;
    }),
  );
  return sections.join("\n\n");
}

export interface InitialContext {
  contextText: string;
}

/**
 * Gathers what the Debug Agent needs before either pass starts: current
 * test status on both sides, plus (if the project is currently running)
 * a one-shot snapshot of each live component's recent logs — never an
 * interactive "fetch logs" tool the model can call mid-loop. See
 * docs/designs/debug-agent.md.
 */
export async function assembleInitialContext(params: {
  description?: string;
  backendDocker: DockerRunner;
  frontendDocker: DockerRunner;
  workspacePath: string;
  liveComponents?: LiveComponent[];
}): Promise<InitialContext> {
  const [backendVerify, frontendVerify] = await Promise.all([
    params.backendDocker.run("bundle exec rspec"),
    params.frontendDocker.run("npx jest"),
  ]);
  const backend = summarizeVerification("bundle exec rspec", backendVerify);
  const frontend = summarizeVerification("npx jest", frontendVerify);

  const hasLiveComponents = !!params.liveComponents && params.liveComponents.length > 0;
  const logsSection = hasLiveComponents
    ? await fetchLiveLogs(params.workspacePath, params.liveComponents!)
    : "";

  const contextText = [
    params.description
      ? `Reported problem:\n\n${params.description}`
      : "No specific description was given — do a general health check across the whole app.",
    `Current backend test status (bundle exec rspec): ${backend.summary}`,
    `Current frontend test status (npx jest): ${frontend.summary}`,
    hasLiveComponents
      ? `The app is currently running live. Recent container logs:\n\n${logsSection}`
      : "The app is not currently running — no live logs available.",
  ].join("\n\n");

  return { contextText };
}
