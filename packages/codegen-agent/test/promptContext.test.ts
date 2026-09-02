import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSystemPrompt, loadBuildSpec } from "../src/promptContext.js";

describe("buildSystemPrompt", () => {
  it("includes the real stack-spec versions and every guideline file", async () => {
    const prompt = await buildSystemPrompt();
    expect(prompt).toContain("Rails");
    expect(prompt).toContain("data-storage.md");
    expect(prompt).toContain("auth.md");
    expect(prompt).toContain("testing.md");
    // Content from inside a guideline file, not just its filename:
    expect(prompt).toContain("MongoDB");
  });

  it("tells the model a final rspec run is the source of truth, not its own claim", async () => {
    const prompt = await buildSystemPrompt();
    expect(prompt.toLowerCase()).toContain("bundle exec rspec");
  });
});

describe("loadBuildSpec", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "codegen-spec-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("parses a build spec JSON file", async () => {
    const specPath = path.join(tempDir, "spec.json");
    await writeFile(
      specPath,
      JSON.stringify({ resource: "Task", fields: [{ name: "title", type: "string" }] }),
    );

    expect(await loadBuildSpec(specPath)).toEqual({
      resource: "Task",
      fields: [{ name: "title", type: "string" }],
    });
  });
});
