#!/usr/bin/env tsx
/**
 * Manual connectivity check against a real GLM endpoint. Requires a valid
 * .env (see .env.example). Not part of the automated test suite — this
 * hits the network.
 *
 * Usage: npm run smoke --workspace @app-builder/llm-client
 */
import { GlmClient, loadGlmConfig } from "../src/index.js";

async function main() {
  const config = loadGlmConfig();
  const client = new GlmClient(config);

  console.log(`Sending a test message to ${config.baseUrl} (model: ${config.model})...`);
  const result = await client.chat({
    messages: [
      { role: "user", content: "Reply with exactly: pong" },
    ],
    maxTokens: 200,
  });

  console.log("Response:", result.message.content);
  console.log("Finish reason:", result.finishReason);
  if (result.usage) console.log("Usage:", result.usage);
  console.log("Raw response:", JSON.stringify(result.raw, null, 2));
}

main().catch((error) => {
  console.error("Smoke test failed:", error);
  process.exitCode = 1;
});
