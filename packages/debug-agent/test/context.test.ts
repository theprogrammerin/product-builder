import { describe, expect, it, vi } from "vitest";
import type { CommandResult, DockerRunner } from "@app-builder/codegen-agent";

const runDockerCompose = vi.fn();
vi.mock("@app-builder/run-agent", () => ({
  runDockerCompose: (...args: unknown[]) => runDockerCompose(...args),
}));

const { assembleInitialContext } = await import("../src/context.js");

function fakeDocker(result: CommandResult): DockerRunner {
  return { run: vi.fn().mockResolvedValue(result), down: vi.fn() };
}

const passingRspec: CommandResult = { exitCode: 0, stdout: "19 examples, 0 failures\n", stderr: "" };
const passingJest: CommandResult = { exitCode: 0, stdout: "", stderr: "Tests: 12 passed, 12 total\n" };

describe("assembleInitialContext", () => {
  it("includes the reported description verbatim when given", async () => {
    const { contextText } = await assembleInitialContext({
      description: "The login screen crashes on submit",
      backendDocker: fakeDocker(passingRspec),
      frontendDocker: fakeDocker(passingJest),
      workspacePath: "/workspace",
    });

    expect(contextText).toContain("Reported problem:");
    expect(contextText).toContain("The login screen crashes on submit");
  });

  it("notes a general health check when no description is given", async () => {
    const { contextText } = await assembleInitialContext({
      backendDocker: fakeDocker(passingRspec),
      frontendDocker: fakeDocker(passingJest),
      workspacePath: "/workspace",
    });

    expect(contextText).toContain("No specific description was given");
    expect(contextText).toContain("general health check");
  });

  it("includes both sides' current test summaries", async () => {
    const failingRspec: CommandResult = { exitCode: 1, stdout: "24 examples, 3 failures\n", stderr: "" };
    const { contextText } = await assembleInitialContext({
      backendDocker: fakeDocker(failingRspec),
      frontendDocker: fakeDocker(passingJest),
      workspacePath: "/workspace",
    });

    expect(contextText).toContain("backend test status (bundle exec rspec): 24 examples, 3 failures");
    expect(contextText).toContain("frontend test status (npx jest): Tests: 12 passed, 12 total");
  });

  it("says the app isn't running when no live components are given", async () => {
    const { contextText } = await assembleInitialContext({
      backendDocker: fakeDocker(passingRspec),
      frontendDocker: fakeDocker(passingJest),
      workspacePath: "/workspace",
    });

    expect(contextText).toContain("not currently running");
    expect(runDockerCompose).not.toHaveBeenCalled();
  });

  it("fetches and includes recent logs for every live component", async () => {
    runDockerCompose.mockResolvedValueOnce({ exitCode: 0, stdout: "rails booted\n", stderr: "" });
    runDockerCompose.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "Metro waiting on 8081\n" });

    const { contextText } = await assembleInitialContext({
      backendDocker: fakeDocker(passingRspec),
      frontendDocker: fakeDocker(passingJest),
      workspacePath: "/workspace",
      liveComponents: [
        { name: "rails", url: "http://localhost:41000" },
        { name: "frontend", url: "http://localhost:41001" },
      ],
    });

    expect(runDockerCompose).toHaveBeenCalledWith("/workspace", ["logs", "--tail=200", "rails"]);
    expect(runDockerCompose).toHaveBeenCalledWith("/workspace", ["logs", "--tail=200", "frontend"]);
    expect(contextText).toContain("currently running live");
    expect(contextText).toContain("rails booted");
    expect(contextText).toContain("Metro waiting on 8081");
  });
});
