import "dotenv/config";
import { GlmClient, loadGlmConfig } from "@app-builder/llm-client";
import { createApp } from "./app.js";
import { createDb, ensureSchema, loadDatabaseUrl } from "./db.js";
import { createPostgresChatStore } from "./postgresChatStore.js";
import { createPostgresProjectStore } from "./postgresProjectStore.js";
import { loadScaffoldConfig } from "./scaffold.js";

async function main() {
  const config = loadGlmConfig();
  const client = new GlmClient(config);

  const db = createDb(loadDatabaseUrl());
  await ensureSchema(db);

  const app = createApp(
    client,
    { baseUrl: config.baseUrl, model: config.model },
    createPostgresChatStore(db),
    createPostgresProjectStore(db),
  );

  const port = Number(process.env.PORT ?? 4000);
  app.listen(port, () => {
    console.log(`Orchestrator listening on http://localhost:${port}`);
    console.log(`GLM endpoint: ${config.baseUrl} (model: ${config.model})`);
    console.log(`Project files dir: ${loadScaffoldConfig().filesDir}`);
    console.log("Database: connected, schema ensured");
  });
}

main().catch((error) => {
  console.error("Orchestrator failed to start:", error);
  process.exitCode = 1;
});
