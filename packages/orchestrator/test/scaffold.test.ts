import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadScaffoldConfig, scaffoldProject } from "../src/scaffold.js";

let tempRoot: string;
let templateDir: string;
let filesDir: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), "scaffold-test-"));
  templateDir = path.join(tempRoot, "template");
  filesDir = path.join(tempRoot, "generated-projects");

  await mkdir(path.join(templateDir, "backend", "app"), { recursive: true });
  await writeFile(path.join(templateDir, "README.md"), "template readme");
  await writeFile(path.join(templateDir, "backend", "Gemfile"), "source ...");
  await writeFile(path.join(templateDir, "backend", "app", ".gitkeep"), "");
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("scaffoldProject", () => {
  it("copies the template tree into <filesDir>/<projectId>", async () => {
    const destination = await scaffoldProject("project-1", { filesDir }, templateDir);

    expect(destination).toBe(path.resolve(filesDir, "project-1"));
    const topLevel = await readdir(destination);
    expect(topLevel.sort()).toEqual(["README.md", "backend"]);
    const backendFiles = await readdir(path.join(destination, "backend"));
    expect(backendFiles.sort()).toEqual(["Gemfile", "app"]);
  });

  it("creates filesDir if it doesn't exist yet", async () => {
    await rm(filesDir, { recursive: true, force: true });
    const destination = await scaffoldProject("project-1", { filesDir }, templateDir);
    const topLevel = await readdir(destination);
    expect(topLevel.length).toBeGreaterThan(0);
  });

  it("throws instead of overwriting if the destination already exists", async () => {
    await scaffoldProject("project-1", { filesDir }, templateDir);
    await expect(scaffoldProject("project-1", { filesDir }, templateDir)).rejects.toThrow();
  });
});

describe("loadScaffoldConfig", () => {
  it("defaults filesDir to ./generated-projects", () => {
    expect(loadScaffoldConfig({} as NodeJS.ProcessEnv)).toEqual({
      filesDir: "./generated-projects",
    });
  });

  it("respects PROJECT_FILES_DIR", () => {
    expect(
      loadScaffoldConfig({ PROJECT_FILES_DIR: "/custom/path" } as NodeJS.ProcessEnv),
    ).toEqual({ filesDir: "/custom/path" });
  });
});
