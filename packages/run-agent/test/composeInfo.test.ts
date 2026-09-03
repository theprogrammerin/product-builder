import { describe, expect, it } from "vitest";
import { parseComposeServices } from "../src/composeInfo.js";

const sampleCompose = `
services:
  rails:
    build: ./backend
    ports:
      - "\${RAILS_HOST_PORT}:3000"
    depends_on:
      - mysql
  frontend:
    build: ./frontend
    ports:
      - "\${FRONTEND_HOST_PORT}:8081"
  mysql:
    image: mysql:8.0
  redis:
    image: redis:7
`;

describe("parseComposeServices", () => {
  it("lists every declared service", () => {
    const info = parseComposeServices(sampleCompose);
    expect(info.serviceNames.sort()).toEqual(["frontend", "mysql", "rails", "redis"]);
  });

  it("finds only services with a ${..._HOST_PORT} placeholder as exposable components", () => {
    const info = parseComposeServices(sampleCompose);
    expect(info.components).toEqual([
      { name: "rails", envVar: "RAILS_HOST_PORT", containerPort: 3000 },
      { name: "frontend", envVar: "FRONTEND_HOST_PORT", containerPort: 8081 },
    ]);
  });

  it("returns no components for a compose file with no exposable services", () => {
    const info = parseComposeServices(`services:\n  mysql:\n    image: mysql:8.0\n`);
    expect(info.components).toEqual([]);
    expect(info.serviceNames).toEqual(["mysql"]);
  });

  it("scales to a third, unrelated component without any code change", () => {
    const withAdmin = sampleCompose + `  admin:\n    build: ./admin\n    ports:\n      - "\${ADMIN_HOST_PORT}:4000"\n`;
    const info = parseComposeServices(withAdmin);
    expect(info.components.map((c) => c.name).sort()).toEqual(["admin", "frontend", "rails"]);
  });

  it("handles a compose file with no services block", () => {
    const info = parseComposeServices("name: empty\n");
    expect(info.serviceNames).toEqual([]);
    expect(info.components).toEqual([]);
  });
});
