import { describe, expect, it } from "vitest";
import { createInMemoryStore } from "../src/chatStore.js";

describe("createInMemoryStore", () => {
  it("stamps createdAt on every appended message (feature #23)", async () => {
    const store = createInMemoryStore();
    await store.append("p1", [{ role: "user", content: "hi" }]);

    const [message] = await store.get("p1");
    expect(message.createdAt).toBeDefined();
    expect(new Date(message.createdAt!).toString()).not.toBe("Invalid Date");
  });

  it("does not mutate the caller's original message object", async () => {
    const store = createInMemoryStore();
    const original = { role: "user" as const, content: "hi" };
    await store.append("p1", [original]);

    expect(original).not.toHaveProperty("createdAt");
  });
});
