export interface GlmConfig {
  /** e.g. "https://open.bigmodel.cn/api/paas/v4", or a self-hosted URL. No trailing slash. */
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
}

export class GlmConfigError extends Error {}

/**
 * Loads and validates GLM endpoint config from environment variables.
 * Fails fast (throws) rather than letting a missing value surface later
 * as a confusing request failure.
 *
 * Required: GLM_BASE_URL, GLM_API_KEY, GLM_MODEL
 * Optional: GLM_TIMEOUT_MS (default 60000), GLM_MAX_RETRIES (default 2)
 */
export function loadGlmConfig(
  env: NodeJS.ProcessEnv = process.env,
): GlmConfig {
  const missing: string[] = [];
  const baseUrl = env.GLM_BASE_URL;
  const apiKey = env.GLM_API_KEY;
  const model = env.GLM_MODEL;

  if (!baseUrl) missing.push("GLM_BASE_URL");
  if (!apiKey) missing.push("GLM_API_KEY");
  if (!model) missing.push("GLM_MODEL");

  if (missing.length > 0) {
    throw new GlmConfigError(
      `Missing required GLM config: ${missing.join(", ")}. ` +
        "Set these as environment variables (see .env.example).",
    );
  }

  const timeoutMs = parsePositiveInt(env.GLM_TIMEOUT_MS, "GLM_TIMEOUT_MS", 60_000);
  const maxRetries = parsePositiveInt(env.GLM_MAX_RETRIES, "GLM_MAX_RETRIES", 2);

  return {
    baseUrl: baseUrl!.replace(/\/+$/, ""),
    apiKey: apiKey!,
    model: model!,
    timeoutMs,
    maxRetries,
  };
}

function parsePositiveInt(
  raw: string | undefined,
  name: string,
  fallback: number,
): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new GlmConfigError(`${name} must be a non-negative number, got: ${raw}`);
  }
  return value;
}
