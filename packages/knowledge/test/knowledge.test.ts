import { describe, it, expect } from "vitest";
import { Atlas, type Plugin } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { createMemoryPlugin, InMemoryStore } from "@atlas/memory";
import { synthesize, createKnowledgePlugin, type Playbook } from "../src/index";

describe("synthesize", () => {
  it("routes lessons into works / avoid / notes sections", () => {
    const pb = synthesize("reels", ["Bold hooks convert best", "Long intros failed", "Post at 8am"]);
    const headings = pb.sections.map((s) => s.heading);
    expect(headings).toContain("What works");
    expect(headings).toContain("What to avoid");
    expect(pb.title).toMatch(/reels/);
  });
});

describe("knowledge plugin", () => {
  it("builds a playbook from lessons stored in memory", async () => {
    const atlas = new Atlas({ guardian: new Guardian() });
    await atlas.use(createMemoryPlugin({ store: new InMemoryStore() }));
    await atlas.use(createKnowledgePlugin());

    let playbook: Playbook | undefined;
    await atlas.use({
      manifest: { name: "librarian", version: "1", capabilities: [], permissions: ["call:memory", "call:knowledge"], role: "executor" },
      async register(ctx) {
        await ctx.call("memory", { op: "remember", input: { kind: "success", content: "Bold hook worked for reels" } });
        await ctx.call("memory", { op: "remember", input: { kind: "failure", content: "Slow intro failed on reels" } });
        playbook = (await ctx.call("knowledge", { op: "playbook", topic: "reels" })) as Playbook;
      },
    } satisfies Plugin);

    expect(playbook!.sections.length).toBeGreaterThan(0);
    expect(playbook!.title).toMatch(/reels/i);
  });
});
