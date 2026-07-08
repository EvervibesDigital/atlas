import { describe, it, expect } from "vitest";
import { Atlas, type Plugin } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { createLearningPlugin, MetricsTracker } from "@atlas/learning";
import { createMemoryPlugin, InMemoryStore } from "@atlas/memory";
import { prioritize, createBusinessPlugin, type Recommendation } from "../src/index";

describe("prioritize", () => {
  it("puts underperformers first as high priority", () => {
    const recs = prioritize([
      { category: "good", successRate: 0.9, total: 10 },
      { category: "bad", successRate: 0.2, total: 10 },
    ]);
    expect(recs[0]!.category).toBe("bad");
    expect(recs[0]!.priority).toBe("high");
  });
});

describe("business plugin brief", () => {
  it("synthesizes a brief from live learning metrics", async () => {
    const atlas = new Atlas({ guardian: new Guardian() });
    await atlas.use(createMemoryPlugin({ store: new InMemoryStore() }));
    await atlas.use(createLearningPlugin({ metrics: new MetricsTracker() }));
    await atlas.use(createBusinessPlugin());

    let brief: { summary: string; recommendations: Recommendation[] } | undefined;
    await atlas.use({
      manifest: { name: "ceo", version: "1", capabilities: [], permissions: ["call:learning", "call:business"], role: "executor" },
      async register(ctx) {
        // Seed some real signal: an area that keeps failing.
        for (let i = 0; i < 4; i++) await ctx.call("learning", { op: "reflect", event: "x", outcome: "failure", category: "wholesale" });
        await ctx.call("learning", { op: "reflect", event: "x", outcome: "success", category: "digital" });
        brief = (await ctx.call("business", { op: "brief" })) as { summary: string; recommendations: Recommendation[] };
      },
    } satisfies Plugin);

    const top = brief!.recommendations[0]!;
    expect(top.category).toBe("wholesale");
    expect(top.priority).toBe("high");
  });
});
