import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFrontendSystemPrompt, buildPlanningSystemPrompt, buildSystemPrompt, loadBuildSpec } from "../src/promptContext.js";

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

  it("tells the backend phase to phrase other-side work as needing a frontend-phase build, not as unreachable (bug #21)", async () => {
    const prompt = await buildSystemPrompt(undefined, { featureSlug: "add-reminders", isIncremental: false });
    expect(prompt).toContain("needing a frontend-phase build to complete it");
    expect(prompt.toLowerCase()).toContain('do not phrase it as unreachable, out of scope, or something "this agent cannot reach"');
  });

  it("warns against breaking/renaming existing resources only in incremental mode", async () => {
    const incremental = await buildSystemPrompt(undefined, { featureSlug: "x", isIncremental: true });
    expect(incremental.toLowerCase()).toContain("already has real backend code");

    const fresh = await buildSystemPrompt(undefined, { featureSlug: "x", isIncremental: false });
    expect(fresh.toLowerCase()).not.toContain("already has real backend code");
  });

  it("includes in-progress design docs and tells the model to trust them, skipping re-verification", async () => {
    const prompt = await buildSystemPrompt(undefined, {
      featureSlug: "voice-notes",
      isIncremental: true,
      inProgressDesignDocs: [{ slug: "voice-notes", content: "## Outcome\n\nBackend: 57/57 passing." }],
    });
    expect(prompt).toContain("### voice-notes");
    expect(prompt).toContain("Backend: 57/57 passing.");
    expect(prompt.toLowerCase()).toContain("do not re-explore or re-verify what's already listed as done");
  });

  it("tells the backend phase it can't reach frontend/ and to stop early if nothing's left on its own side (bug #20)", async () => {
    const prompt = await buildSystemPrompt(undefined, {
      featureSlug: "voice-notes",
      isIncremental: true,
      inProgressDesignDocs: [{ slug: "voice-notes", content: "## Outcome\n\nBackend: 57/57 passing. Left: frontend wiring." }],
    });
    expect(prompt.toLowerCase()).toContain("your tools only reach this project's backend/ directory");
    expect(prompt.toLowerCase()).toContain("cannot see or reach its frontend/ code");
    expect(prompt.toLowerCase()).toContain("do not repeatedly search for the other side's files");
  });

  it("omits the in-progress design docs section when none are given", async () => {
    const prompt = await buildSystemPrompt(undefined, { featureSlug: "x", isIncremental: false });
    expect(prompt.toLowerCase()).not.toContain("in-progress work on this project");
  });

  it("tells the phase to execute a Plan section directly, not enter discovery mode, when one exists (feature #22)", async () => {
    const withPlan = await buildSystemPrompt(undefined, {
      featureSlug: "voice-notes",
      isIncremental: true,
      inProgressDesignDocs: [
        { slug: "voice-notes", content: "## Plan\n\nScope: backend-only\n\n### Backend\n1. app/models/voice_note.rb — add a field" },
      ],
    });
    expect(withPlan.toLowerCase()).toContain("authoritative task list");
    expect(withPlan.toLowerCase()).toContain("do not enter code-discovery mode");
    expect(withPlan.toLowerCase()).toContain("the files the plan lists for the backend side");

    const withoutPlan = await buildSystemPrompt(undefined, {
      featureSlug: "voice-notes",
      isIncremental: true,
      inProgressDesignDocs: [{ slug: "voice-notes", content: "## Outcome\n\nBackend: 57/57 passing." }],
    });
    expect(withoutPlan.toLowerCase()).not.toContain("authoritative task list");
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

  it("tells the frontend phase to phrase other-side work as needing a backend-phase build, not as unreachable (bug #21)", async () => {
    const prompt = await buildFrontendSystemPrompt(undefined, { featureSlug: "add-reminders", isIncremental: false });
    expect(prompt).toContain("needing a backend-phase build to complete it");
    expect(prompt.toLowerCase()).toContain('do not phrase it as unreachable, out of scope, or something "this agent cannot reach"');
  });

  it("warns against removing/restructuring existing screens only in incremental mode", async () => {
    const incremental = await buildFrontendSystemPrompt(undefined, { featureSlug: "x", isIncremental: true });
    expect(incremental.toLowerCase()).toContain("already has real frontend code");

    const fresh = await buildFrontendSystemPrompt(undefined, { featureSlug: "x", isIncremental: false });
    expect(fresh.toLowerCase()).not.toContain("already has real frontend code");
  });

  it("includes in-progress design docs and tells the model to trust them, skipping re-verification", async () => {
    const prompt = await buildFrontendSystemPrompt(undefined, {
      featureSlug: "voice-notes",
      isIncremental: true,
      inProgressDesignDocs: [{ slug: "voice-notes", content: "## Outcome\n\nLeft: frontend wiring." }],
    });
    expect(prompt).toContain("### voice-notes");
    expect(prompt).toContain("Left: frontend wiring.");
    expect(prompt.toLowerCase()).toContain("do not re-explore or re-verify what's already listed as done");
  });

  it("tells the frontend phase it can't reach backend/ and to stop early if nothing's left on its own side (bug #20)", async () => {
    const prompt = await buildFrontendSystemPrompt(undefined, {
      featureSlug: "voice-notes",
      isIncremental: true,
      inProgressDesignDocs: [{ slug: "voice-notes", content: "## Outcome\n\nLeft: backend fix." }],
    });
    expect(prompt.toLowerCase()).toContain("your tools only reach this project's frontend/ directory");
    expect(prompt.toLowerCase()).toContain("cannot see or reach its backend/ code");
    expect(prompt.toLowerCase()).toContain("do not repeatedly search for the other side's files");
  });

  it("tells the frontend phase to execute a Plan section directly, not enter discovery mode, when one exists (feature #22)", async () => {
    const prompt = await buildFrontendSystemPrompt(undefined, {
      featureSlug: "voice-notes",
      isIncremental: true,
      inProgressDesignDocs: [
        { slug: "voice-notes", content: "## Plan\n\nScope: frontend-only\n\n### Frontend\n1. src/screens/RecordVoiceNoteScreen.tsx — wire upload" },
      ],
    });
    expect(prompt.toLowerCase()).toContain("authoritative task list");
    expect(prompt.toLowerCase()).toContain("do not enter code-discovery mode");
    expect(prompt.toLowerCase()).toContain("the files the plan lists for the frontend side");
  });
});

describe("buildPlanningSystemPrompt (feature #22)", () => {
  it("instructs the model to determine scope and write a file-level plan, not application code", () => {
    const prompt = buildPlanningSystemPrompt();
    expect(prompt.toLowerCase()).toContain("must not write or modify any application code");
    expect(prompt).toContain("SCOPE");
    expect(prompt).toContain("PLAN");
    expect(prompt).toContain('"Scope: backend-only"');
    expect(prompt).toContain('"Scope: frontend-only"');
    expect(prompt).toContain('"Scope: both"');
    expect(prompt).toContain("write_project_doc");
  });

  it("tells the model to reuse an existing accurate plan rather than re-deriving it", () => {
    const prompt = buildPlanningSystemPrompt();
    expect(prompt.toLowerCase()).toContain("reuse it rather than re-deriving it from scratch");
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
