import { describe, it, expect } from "vitest";
import { Atlas, type Plugin } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { createMemoryPlugin, InMemoryStore } from "@atlas/memory";
import { createLearningPlugin } from "@atlas/learning";
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

  it("auto-refreshes a category's playbook once enough reflections accumulate (Knowledge Engineering Division)", async () => {
    const atlas = new Atlas({ guardian: new Guardian() });
    await atlas.use(createMemoryPlugin({ store: new InMemoryStore() }));
    await atlas.use(createLearningPlugin());
    await atlas.use(createKnowledgePlugin());

    let refreshed: { topic: string; sections: number } | undefined;
    await atlas.use({
      manifest: { name: "watcher", version: "1", capabilities: [], permissions: ["call:learning"], role: "executor" },
      async register(ctx) {
        ctx.on("knowledge.autoRefreshed", (payload) => {
          refreshed = payload as { topic: string; sections: number };
        });
        // 5 reflections in the same category should cross AUTO_SYNTH_THRESHOLD.
        for (let i = 0; i < 5; i++) {
          await ctx.call("learning", { op: "reflect", event: "test.event", outcome: i % 2 === 0 ? "success" : "failure", category: "gigfinder", detail: `run ${i}` });
        }
      },
    } satisfies Plugin);

    expect(refreshed).toBeDefined();
    expect(refreshed!.topic).toBe("gigfinder");
    expect(refreshed!.sections).toBeGreaterThan(0);
  });
});
