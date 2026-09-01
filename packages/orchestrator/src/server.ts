import "dotenv/config";
import { GlmClient, loadGlmConfig } from "@app-builder/llm-client";
import { createApp } from "./app.js";
import { loadScaffoldConfig } from "./scaffold.js";

const config = loadGlmConfig();
const client = new GlmClient(config);
const app = createApp(client, { baseUrl: config.baseUrl, model: config.model });

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`Orchestrator listening on http://localhost:${port}`);
  console.log(`GLM endpoint: ${config.baseUrl} (model: ${config.model})`);
  console.log(`Project files dir: ${loadScaffoldConfig().filesDir}`);
});
