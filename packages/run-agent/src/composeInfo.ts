import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

export interface ComponentSpec {
  /** docker-compose service name, e.g. "rails", "frontend". */
  name: string;
  /** Env var the Run Agent sets to the allocated host port before `docker compose up -d`. */
  envVar: string;
  containerPort: number;
}

export interface ComposeInfo {
  /** Every service name declared in the compose file. */
  serviceNames: string[];
  /** Services that declare a `${..._HOST_PORT}`-shaped port placeholder — the ones the Run Agent exposes. */
  components: ComponentSpec[];
}

interface ComposeService {
  ports?: string[];
}

interface ComposeDoc {
  services?: Record<string, ComposeService>;
}

// Matches "${NAME_HOST_PORT}:CONTAINER_PORT" — the convention this
// project's docker-compose.yml uses to mark a service as exposable. See
// docs/designs/run-deploy-agent.md.
const HOST_PORT_PLACEHOLDER = /^\$\{([A-Z0-9_]+_HOST_PORT)\}:(\d+)$/;

/**
 * Pure parsing logic, kept separate from file I/O so it's directly
 * unit-testable without a real docker-compose.yml on disk.
 */
export function parseComposeServices(yamlText: string): ComposeInfo {
  const doc = (parse(yamlText) ?? {}) as ComposeDoc;
  const services = doc.services ?? {};
  const serviceNames = Object.keys(services);

  const components: ComponentSpec[] = [];
  for (const [name, service] of Object.entries(services)) {
    for (const portMapping of service.ports ?? []) {
      const match = HOST_PORT_PLACEHOLDER.exec(portMapping);
      if (match) {
        components.push({ name, envVar: match[1]!, containerPort: Number(match[2]) });
        break; // one exposed port per component
      }
    }
  }

  return { serviceNames, components };
}

export async function loadComposeInfo(workspaceRoot: string): Promise<ComposeInfo> {
  const yamlText = await readFile(path.join(workspaceRoot, "docker-compose.yml"), "utf-8");
  return parseComposeServices(yamlText);
}
