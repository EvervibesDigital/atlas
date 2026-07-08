import { describe, it, expect } from "vitest";
import { Atlas, type Plugin } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { createMemoryPlugin, InMemoryStore } from "@atlas/memory";
import { scoreDiscovery, rankDiscoveries, createResearchPlugin, type Discovery, type RankedDiscovery } from "../src/index";

describe("discovery ranking", () => {
  it("scores a free, open-source, self-hostable tool higher than a closed one", () => {
    const open: Discovery = { title: "A", summary: "", free: true, openSource: true, selfHostable: true, hasApi: true };
    const closed: Discovery = { title: "B", summary: "", free: false };
    expect(scoreDiscovery(open).score).toBeGreaterThan(scoreDiscovery(closed).score);
    expect(scoreDiscovery(open).reasons).toContain("free");
  });

  it("ranks a list best-first", () => {
    const ranked = rankDiscoveries([
      { title: "meh", summary: "" },
      { title: "great", summary: "", free: true, openSource: true, mcp: true },
    ]);
    expect(ranked[0]!.title).toBe("great");
  });
});

describe("research plugin", () => {
  it("ingests discoveries and reports them ranked", async () => {
    const atlas = new Atlas({ guardian: new Guardian() });
    await atlas.use(createMemoryPlugin({ store: new InMemoryStore() }));
    await atlas.use(createResearchPlugin());

    let report: RankedDiscovery[] = [];
    await atlas.use({
      manifest: { name: "scout", version: "1", capabilities: [], permissions: ["call:research"], role: "executor" },
      async register(ctx) {
        await ctx.call("research", { op: "ingest", discovery: { title: "Boring SaaS", summary: "closed" } });
        await ctx.call("research", { op: "ingest", discovery: { title: "Free MCP tool", summary: "great", free: true, mcp: true, openSource: true } });
        report = (await ctx.call("research", { op: "report" })) as RankedDiscovery[];
      },
    } satisfies Plugin);

    expect(report[0]!.title).toBe("Free MCP tool");
  });
});
