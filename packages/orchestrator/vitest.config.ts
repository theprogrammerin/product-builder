import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Scaffolded projects live under generated-projects/ (gitignored dev
    // data, not orchestrator source) and — since frontend generation —
    // can contain their own Jest/RNTL test files. Vitest's default
    // excludes don't cover this project-specific directory, so without
    // this it tries (and fails) to run someone else's generated tests
    // through its own transform pipeline.
    exclude: ["**/node_modules/**", "**/dist/**", "generated-projects/**"],
  },
});
