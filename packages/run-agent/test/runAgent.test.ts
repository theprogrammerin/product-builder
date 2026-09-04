import { describe, expect, it, vi } from "vitest";
import { createRunAgent, type RunAgentDeps } from "../src/runAgent.js";
import type { CommandResult } from "../src/dockerCompose.js";

const ok: CommandResult = { exitCode: 0, stdout: "ok", stderr: "" };
const failure: CommandResult = { exitCode: 1, stdout: "", stderr: "boom" };

function makeDeps(overrides: Partial<RunAgentDeps> = {}): RunAgentDeps {
  let nextPort = 40000;
  return {
    loadComposeInfo: vi.fn().mockResolvedValue({
      serviceNames: ["rails", "frontend", "mysql", "mongo", "redis"],
      components: [
        { name: "rails", envVar: "RAILS_HOST_PORT", containerPort: 3000 },
        { name: "frontend", envVar: "FRONTEND_HOST_PORT", containerPort: 8081 },
      ],
    }),
    runDockerCompose: vi.fn().mockResolvedValue(ok),
    findFreePort: vi.fn().mockImplementation(async () => nextPort++),
    waitForHealthy: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe("createRunAgent().start", () => {
  it("brings up dependencies, migrates, brings up components, and reports live URLs", async () => {
    const deps = makeDeps();
    const agent = createRunAgent(deps);

    const result = await agent.start({ workspacePath: "/workspace" });

    expect(result.status).toBe("live");
    expect(result.components).toEqual([
      { name: "rails", port: 40000, url: "http://localhost:40000" },
      { name: "frontend", port: 40001, url: "http://localhost:40001" },
    ]);

    const calls = (deps.runDockerCompose as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]).toEqual(["/workspace", ["up", "-d", "mysql", "mongo", "redis"]]);
    expect(calls[1][1]).toEqual(["run", "--rm", "-T", "rails", "bash", "-lc", "bin/rails db:create db:migrate"]);
    expect(calls[2]).toEqual([
      "/workspace",
      ["up", "-d", "rails", "frontend"],
      {
        RAILS_HOST_PORT: "40000",
        RAILS_URL: "http://localhost:40000",
        FRONTEND_HOST_PORT: "40001",
        FRONTEND_URL: "http://localhost:40001",
      },
    ]);
  });

  it("scales to however many components docker-compose.yml declares, not a fixed backend/frontend pair", async () => {
    const deps = makeDeps({
      loadComposeInfo: vi.fn().mockResolvedValue({
        serviceNames: ["api", "worker", "admin", "postgres"],
        components: [
          { name: "api", envVar: "API_HOST_PORT", containerPort: 4000 },
          { name: "admin", envVar: "ADMIN_HOST_PORT", containerPort: 5000 },
        ],
      }),
    });
    const agent = createRunAgent(deps);

    const result = await agent.start({ workspacePath: "/workspace" });

    expect(result.status).toBe("live");
    expect(result.components.map((c) => c.name)).toEqual(["api", "admin"]);
    // No "rails" component present — migration step must be skipped entirely.
    const commands = (deps.runDockerCompose as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1][0]);
    expect(commands).not.toContain("run");
  });

  it("provides every component's URL to every component, not just its own port", async () => {
    const deps = makeDeps();
    const agent = createRunAgent(deps);

    await agent.start({ workspacePath: "/workspace" });

    const upComponentsCall = (deps.runDockerCompose as ReturnType<typeof vi.fn>).mock.calls[2];
    const env = upComponentsCall[2] as Record<string, string>;
    // "frontend" needs RAILS_URL to reach the backend; "rails" needs
    // FRONTEND_URL for CORS — both must be present regardless of which
    // service actually owns that port. See docs/designs/component-networking.md.
    expect(env.RAILS_URL).toBe("http://localhost:40000");
    expect(env.FRONTEND_URL).toBe("http://localhost:40001");
  });

  it("fails without touching docker if docker-compose.yml can't be read", async () => {
    const deps = makeDeps({ loadComposeInfo: vi.fn().mockRejectedValue(new Error("ENOENT")) });
    const agent = createRunAgent(deps);

    const result = await agent.start({ workspacePath: "/workspace" });

    expect(result).toEqual({ status: "failed", components: [], error: expect.stringContaining("ENOENT") });
    expect(deps.runDockerCompose).not.toHaveBeenCalled();
  });

  it("fails cleanly if there are no exposable components", async () => {
    const deps = makeDeps({
      loadComposeInfo: vi.fn().mockResolvedValue({ serviceNames: ["mysql"], components: [] }),
    });
    const agent = createRunAgent(deps);

    const result = await agent.start({ workspacePath: "/workspace" });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/no exposable components/i);
  });

  it("fails if bringing up dependencies fails", async () => {
    const deps = makeDeps({ runDockerCompose: vi.fn().mockResolvedValueOnce(failure) });
    const agent = createRunAgent(deps);

    const result = await agent.start({ workspacePath: "/workspace" });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("boom");
  });

  it("fails if migration fails, without ever bringing up the components", async () => {
    const deps = makeDeps({
      runDockerCompose: vi.fn().mockResolvedValueOnce(ok).mockResolvedValueOnce(failure),
    });
    const agent = createRunAgent(deps);

    const result = await agent.start({ workspacePath: "/workspace" });

    expect(result.status).toBe("failed");
    expect(deps.runDockerCompose).toHaveBeenCalledTimes(2);
  });

  it("fails if a health check times out, naming which component", async () => {
    const deps = makeDeps({
      waitForHealthy: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
    });
    const agent = createRunAgent(deps);

    const result = await agent.start({ workspacePath: "/workspace" });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("frontend");
  });
});

describe("createRunAgent().stop", () => {
  it("stops the whole stack with no service arguments", async () => {
    const deps = makeDeps();
    const agent = createRunAgent(deps);

    await agent.stop({ workspacePath: "/workspace" });

    expect(deps.runDockerCompose).toHaveBeenCalledWith("/workspace", ["stop"]);
  });
});
