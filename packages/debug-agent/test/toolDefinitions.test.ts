import { describe, expect, it } from "vitest";
import { buildDebugToolDefinitions } from "../src/toolDefinitions.js";

describe("buildDebugToolDefinitions", () => {
  it("exposes the same five read/write/list/search tool names plus run_command as codegen-agent, for either side", () => {
    const names = buildDebugToolDefinitions("backend").map((t) => t.function.name);
    expect(names).toEqual(["read_file", "write_file", "list_dir", "list_files", "search_files", "run_command"]);
  });

  it("describes paths as relative to the project root, not backend/ or frontend/ alone", () => {
    const [readFile] = buildDebugToolDefinitions("backend");
    expect(readFile.function.description).toContain("relative to the project root");
    expect(readFile.function.description).toContain("CLAUDE.md");
    expect(readFile.function.description).toContain("docs/backlog.md");
  });

  it("scopes run_command's description to the rails service for backend, frontend service for frontend", () => {
    const backendRunCommand = buildDebugToolDefinitions("backend").find((t) => t.function.name === "run_command")!;
    const frontendRunCommand = buildDebugToolDefinitions("frontend").find((t) => t.function.name === "run_command")!;

    expect(backendRunCommand.function.description).toContain("docker compose run --rm rails");
    expect(backendRunCommand.function.description).toContain("bundle exec rspec");
    expect(frontendRunCommand.function.description).toContain("docker compose run --rm frontend");
    expect(frontendRunCommand.function.description).toContain("npx jest");
  });

  it("points list_files/search_files at the right code subdirectory per side", () => {
    const backendSearch = buildDebugToolDefinitions("backend").find((t) => t.function.name === "search_files")!;
    const frontendSearch = buildDebugToolDefinitions("frontend").find((t) => t.function.name === "search_files")!;

    expect(backendSearch.function.description).toContain("backend/");
    expect(frontendSearch.function.description).toContain("frontend/");
  });
});
