import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/promptContext.js";

describe("buildSystemPrompt", () => {
  it("explains the markdown shape for a spec response", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("## Resource");
    expect(prompt).toContain("## Fields");
  });

  it("tells the model to prefix a clarifying question with QUESTION:", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("QUESTION:");
  });

  it("lists the allowed Rails migration field types", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("string");
    expect(prompt).toContain("boolean");
    expect(prompt).toContain("datetime");
  });

  it("tells the model it can describe more than one related resource", () => {
    const prompt = buildSystemPrompt().toLowerCase();
    expect(prompt).toContain("several related ones");
    expect(prompt).toContain("no cap on how many");
  });

  it("explains the associations shape and vocabulary", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("## Associations");
    expect(prompt).toContain("belongs_to");
    expect(prompt).toContain("has_many");
    expect(prompt).toContain("has_one");
  });

  it("explains the screens shape, one section for the whole app", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("## Screens");
    expect(prompt).toContain("Objective:");
    expect(prompt).toContain("Shows:");
    expect(prompt.toLowerCase()).toContain("not per-resource");
  });

  it("tells the model screens alone aren't a reason to ask a clarifying question", () => {
    const prompt = buildSystemPrompt().toLowerCase();
    expect(prompt).toContain("screens alone are not a reason");
  });
});
