import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathEscapeError, createFileTools, resolveScoped } from "../src/tools.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "codegen-tools-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolveScoped", () => {
  it("resolves a path inside the root", () => {
    expect(resolveScoped(root, "app/models/task.rb")).toBe(path.join(root, "app/models/task.rb"));
  });

  it("resolves the root itself", () => {
    expect(resolveScoped(root, ".")).toBe(path.resolve(root));
  });

  it("rejects a relative path that escapes the root", () => {
    expect(() => resolveScoped(root, "../outside.txt")).toThrow(PathEscapeError);
  });

  it("rejects an absolute path outside the root", () => {
    expect(() => resolveScoped(root, "/etc/passwd")).toThrow(PathEscapeError);
  });

  it("rejects a path that traverses out and back to a sibling", () => {
    expect(() => resolveScoped(root, "../sibling/file.rb")).toThrow(PathEscapeError);
  });
});

describe("createFileTools", () => {
  it("writes and reads back a file, creating parent directories", async () => {
    const tools = createFileTools(root);
    await tools.writeFile("app/models/task.rb", "class Task; end\n");
    expect(await tools.readFile("app/models/task.rb")).toBe("class Task; end\n");
  });

  it("lists directory entries", async () => {
    const tools = createFileTools(root);
    await tools.writeFile("app/models/task.rb", "");
    await tools.writeFile("app/models/user.rb", "");
    expect((await tools.listDir("app/models")).sort()).toEqual(["task.rb", "user.rb"]);
  });

  it("propagates a path-escape rejection instead of touching the filesystem", async () => {
    const tools = createFileTools(root);
    await expect(tools.writeFile("../escape.rb", "evil")).rejects.toThrow(PathEscapeError);
  });

  it("listFiles recursively lists files, skipping .git/tmp/log/node_modules", async () => {
    const tools = createFileTools(root);
    await tools.writeFile("app/models/task.rb", "");
    await tools.writeFile("app/controllers/tasks_controller.rb", "");
    await tools.writeFile("Gemfile", "");
    await tools.writeFile(".git/HEAD", "");
    await tools.writeFile("tmp/cache.txt", "");
    await tools.writeFile("node_modules/foo/index.js", "");

    expect((await tools.listFiles()).sort()).toEqual(
      ["Gemfile", "app/controllers/tasks_controller.rb", "app/models/task.rb"].sort(),
    );
  });

  it("listFiles scopes to a subdirectory when given a path", async () => {
    const tools = createFileTools(root);
    await tools.writeFile("app/models/task.rb", "");
    await tools.writeFile("Gemfile", "");

    expect(await tools.listFiles("app/models")).toEqual(["app/models/task.rb"]);
  });

  it("searchFiles finds matches across files with path/line/text", async () => {
    const tools = createFileTools(root);
    await tools.writeFile("app/models/task.rb", "class Task < ApplicationRecord\nend\n");
    await tools.writeFile("app/models/user.rb", "class User < ApplicationRecord\nend\n");

    const matches = await tools.searchFiles("class Task");
    expect(matches).toEqual([
      { path: "app/models/task.rb", line: 1, text: "class Task < ApplicationRecord" },
    ]);
  });

  it("searchFiles falls back to a literal match when the pattern isn't valid regex", async () => {
    const tools = createFileTools(root);
    await tools.writeFile("app/models/task.rb", "belongs_to :user (optional)\n");

    const matches = await tools.searchFiles("(optional)");
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ path: "app/models/task.rb", line: 1 });
  });

  it("searchFiles returns no matches gracefully", async () => {
    const tools = createFileTools(root);
    await tools.writeFile("app/models/task.rb", "class Task; end\n");

    expect(await tools.searchFiles("NoSuchThing")).toEqual([]);
  });
});
