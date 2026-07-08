import { describe, it, expect } from "vitest";
import { Atlas, type Plugin } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { createMemoryPlugin, InMemoryStore } from "../src/index";
import type { MemoryRecord, SearchResult } from "../src/types";

/** End-to-end through the real kernel + Guardian, using an in-memory store. */
describe("memory plugin wired through the kernel", () => {
  it("lets a permitted consumer remember and search", async () => {
    const atlas = new Atlas({ guardian: new Guardian() });
    await atlas.use(createMemoryPlugin({ store: new InMemoryStore() }));

    let remembered: MemoryRecord | undefined;
    let hits: SearchResult[] = [];

    const consumer: Plugin = {
      manifest: { name: "learner", version: "1", capabilities: [], permissions: ["call:memory"], role: "executor" },
      async register(ctx) {
        remembered = (await ctx.call("memory", {
          op: "remember",
          input: { kind: "success", content: "cold DMs at 8am got the best reply rate" },
        })) as MemoryRecord;
        hits = (await ctx.call("memory", { op: "search", query: "best time to send DMs" })) as SearchResult[];
      },
    };
    await atlas.use(consumer);

    expect(remembered?.id).toBeTruthy();
    expect(hits[0]?.record.content).toMatch(/8am/);
  });

  it("blocks a consumer without call:memory permission", async () => {
    const atlas = new Atlas({ guardian: new Guardian() });
    await atlas.use(createMemoryPlugin({ store: new InMemoryStore() }));

    const sneaky: Plugin = {
      manifest: { name: "sneaky", version: "1", capabilities: [], permissions: [], role: "executor" },
      async register(ctx) {
        await ctx.call("memory", { op: "recent" });
      },
    };
    await expect(atlas.use(sneaky)).rejects.toThrow(/Guardian deny/);
  });
});
