#!/usr/bin/env node
import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { GlmClient, loadGlmConfig } from "@app-builder/llm-client";
import { EmptyIntakeResponseError, runIntake } from "./agent.js";
import { buildSystemPrompt } from "./promptContext.js";

interface Args {
  description: string;
  out: string;
}

async function parseArgs(argv: string[]): Promise<Args> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    const value = argv[i + 1];
    if (key && value !== undefined) args[key] = value;
  }

  if (!args.out || (!args.description && !args["description-file"])) {
    throw new Error(
      'Usage: intake-agent --description "<text>" --out <path-to-spec.md>\n' +
        "   or: intake-agent --description-file <path> --out <path-to-spec.md>",
    );
  }

  const description = args["description-file"]
    ? await readFile(path.resolve(args["description-file"]), "utf8")
    : args.description;

  return { description, out: args.out };
}

async function main() {
  const { description, out } = await parseArgs(process.argv.slice(2));

  const config = loadGlmConfig();
  const llmClient = new GlmClient(config);
  const systemPrompt = buildSystemPrompt();

  const result = await runIntake({ llmClient, systemPrompt, description });

  if (result.kind === "question") {
    console.log(`Need more information before a spec can be written:\n\n${result.content}`);
    console.log("\nRe-run with a fuller --description once you have an answer.");
    process.exitCode = 1;
    return;
  }

  const outPath = path.resolve(out);
  await writeFile(outPath, result.content, "utf8");
  console.log(`Wrote build spec to ${outPath}`);
}

main().catch((error) => {
  if (error instanceof EmptyIntakeResponseError) {
    console.error(
      "The model returned an empty response twice in a row. This is " +
        "usually transient — try again, or simplify the description if it " +
        "keeps happening.",
    );
  } else {
    console.error("Intake Agent failed:", error);
  }
  process.exitCode = 1;
});
