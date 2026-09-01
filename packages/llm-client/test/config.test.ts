import { describe, expect, it } from "vitest";
import { GlmConfigError, loadGlmConfig } from "../src/config.js";

const validEnv = {
  GLM_BASE_URL: "https://open.bigmodel.cn/api/paas/v4/",
  GLM_API_KEY: "test-key",
  GLM_MODEL: "glm-4.6",
} as NodeJS.ProcessEnv;

describe("loadGlmConfig", () => {
  it("loads a valid config and strips a trailing slash from baseUrl", () => {
    const config = loadGlmConfig(validEnv);
    expect(config).toEqual({
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      apiKey: "test-key",
      model: "glm-4.6",
      timeoutMs: 60_000,
      maxRetries: 2,
    });
  });

  it("applies GLM_TIMEOUT_MS and GLM_MAX_RETRIES overrides", () => {
    const config = loadGlmConfig({
      ...validEnv,
      GLM_TIMEOUT_MS: "15000",
      GLM_MAX_RETRIES: "5",
    } as NodeJS.ProcessEnv);
    expect(config.timeoutMs).toBe(15_000);
    expect(config.maxRetries).toBe(5);
  });

  it.each([["GLM_BASE_URL"], ["GLM_API_KEY"], ["GLM_MODEL"]])(
    "throws GlmConfigError when %s is missing",
    (key) => {
      const env = { ...validEnv } as Record<string, string>;
      delete env[key];
      expect(() => loadGlmConfig(env as NodeJS.ProcessEnv)).toThrow(
        GlmConfigError,
      );
    },
  );

  it("throws when multiple required vars are missing, naming all of them", () => {
    expect(() => loadGlmConfig({} as NodeJS.ProcessEnv)).toThrow(
      /GLM_BASE_URL.*GLM_API_KEY.*GLM_MODEL/s,
    );
  });

  it("throws GlmConfigError for a negative GLM_TIMEOUT_MS", () => {
    expect(() =>
      loadGlmConfig({ ...validEnv, GLM_TIMEOUT_MS: "-1" } as NodeJS.ProcessEnv),
    ).toThrow(GlmConfigError);
  });

  it("throws GlmConfigError for a non-numeric GLM_MAX_RETRIES", () => {
    expect(() =>
      loadGlmConfig({ ...validEnv, GLM_MAX_RETRIES: "abc" } as NodeJS.ProcessEnv),
    ).toThrow(GlmConfigError);
  });
});
