import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFrontendSystemPrompt, buildSystemPrompt, loadBuildSpec } from "../src/promptContext.js";

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

  it("omits the Feature workflow / project-doc instructions when no featureWorkflow is given (standalone CLI)", async () => {
    const prompt = await buildSystemPrompt();
    expect(prompt).not.toContain("read_project_doc");
    expect(prompt).not.toContain("write_project_doc");
  });

  it("includes the Feature workflow instructions, with the given slug, when featureWorkflow is supplied", async () => {
    const prompt = await buildSystemPrompt(undefined, { featureSlug: "add-reminders", isIncremental: false });
    expect(prompt).toContain('read_project_doc("docs/designs/add-reminders.md")');
    expect(prompt).toContain('write_project_doc("docs/designs/add-reminders.md"');
    expect(prompt).toContain("docs/backlog.md");
    expect(prompt).toContain("docs/blueprints/features.md");
    expect(prompt).toContain("CHANGELOG.md");
  });

  it("warns against breaking/renaming existing resources only in incremental mode", async () => {
    const incremental = await buildSystemPrompt(undefined, { featureSlug: "x", isIncremental: true });
    expect(incremental.toLowerCase()).toContain("already has real backend code");

    const fresh = await buildSystemPrompt(undefined, { featureSlug: "x", isIncremental: false });
    expect(fresh.toLowerCase()).not.toContain("already has real backend code");
  });
});

describe("buildFrontendSystemPrompt", () => {
  it("includes the real stack-spec versions and every guideline file", async () => {
    const prompt = await buildFrontendSystemPrompt();
    expect(prompt).toContain("React Navigation");
    expect(prompt).toContain("frontend-architecture.md");
    expect(prompt).toContain("testing.md");
    // Content from inside a guideline file, not just its filename:
    expect(prompt).toContain("Zustand");
  });

  it("tells the model a final npx jest run is the source of truth, not its own claim", async () => {
    const prompt = await buildFrontendSystemPrompt();
    expect(prompt.toLowerCase()).toContain("npx jest");
  });

  it("tells the model to implement exactly the reviewed ## Screens plan, not its own set", async () => {
    const prompt = await buildFrontendSystemPrompt();
    expect(prompt).toContain("## Screens");
    expect(prompt.toLowerCase()).toContain("already reviewed and approved");
  });

  it("scopes its tools to frontend/, not backend/", async () => {
    const prompt = await buildFrontendSystemPrompt();
    expect(prompt).toContain("frontend/");
  });

  it("distinguishes must-pass failures from nice-to-have ones it may skip", async () => {
    const prompt = await buildFrontendSystemPrompt();
    expect(prompt.toLowerCase()).toContain("nice-to-have");
    expect(prompt).toContain("it.skip");
    expect(prompt.toLowerCase()).toContain("never skip a must-pass test");
  });

  it("omits the Feature workflow / project-doc instructions when no featureWorkflow is given (standalone CLI)", async () => {
    const prompt = await buildFrontendSystemPrompt();
    expect(prompt).not.toContain("read_project_doc");
    expect(prompt).not.toContain("write_project_doc");
  });

  it("includes the Feature workflow instructions, with the given slug, when featureWorkflow is supplied", async () => {
    const prompt = await buildFrontendSystemPrompt(undefined, { featureSlug: "add-reminders", isIncremental: false });
    expect(prompt).toContain('read_project_doc("docs/designs/add-reminders.md")');
    expect(prompt).toContain('write_project_doc("docs/designs/add-reminders.md"');
  });

  it("warns against removing/restructuring existing screens only in incremental mode", async () => {
    const incremental = await buildFrontendSystemPrompt(undefined, { featureSlug: "x", isIncremental: true });
    expect(incremental.toLowerCase()).toContain("already has real frontend code");

    const fresh = await buildFrontendSystemPrompt(undefined, { featureSlug: "x", isIncremental: false });
    expect(fresh.toLowerCase()).not.toContain("already has real frontend code");
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

  it("reads a build spec file verbatim, as plain text", async () => {
    const specPath = path.join(tempDir, "spec.md");
    const content = "## Resource\nTask\n\n## Fields\n- title: string\n";
    await writeFile(specPath, content);

    expect(await loadBuildSpec(specPath)).toBe(content);
  });
});
