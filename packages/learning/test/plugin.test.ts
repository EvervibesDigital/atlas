import { describe, it, expect } from "vitest";
import { Atlas, type Plugin } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { createMemoryPlugin, InMemoryStore } from "@atlas/memory";
import { createApprovalsPlugin, ApprovalGateway, type Approval } from "@atlas/approvals";
import { createLearningPlugin, MetricsTracker } from "../src/index";
import type { CategoryMetrics, Proposal, Reflection } from "../src/types";

describe("learning plugin wired through the kernel", () => {
  it("records an explicit reflection into metrics AND long-term memory", async () => {
    const atlas = new Atlas({ guardian: new Guardian() });
    await atlas.use(createMemoryPlugin({ store: new InMemoryStore() }));
    await atlas.use(createLearningPlugin({ metrics: new MetricsTracker() }));

    let stats: CategoryMetrics | undefined;
    let memoryHits: unknown[] = [];
    await atlas.use({
      manifest: { name: "coach", version: "1", capabilities: [], permissions: ["call:learning", "call:memory"], role: "executor" },
      async register(ctx) {
        await ctx.call("learning", { op: "reflect", event: "test", outcome: "success", category: "reels", detail: "hook A" });
        stats = (await ctx.call("learning", { op: "metrics", category: "reels" })) as CategoryMetrics;
        memoryHits = (await ctx.call("memory", { op: "search", query: "hook worked for reels" })) as unknown[];
      },
    } satisfies Plugin);

    expect(stats?.successes).toBe(1);
    expect(memoryHits.length).toBeGreaterThan(0);
  });

  it("auto-learns from an approval being granted (event-driven)", async () => {
    const atlas = new Atlas({ guardian: new Guardian() });
    await atlas.use(createMemoryPlugin({ store: new InMemoryStore() }));
    await atlas.use(createApprovalsPlugin({ gateway: new ApprovalGateway() }));
    await atlas.use(createLearningPlugin({ metrics: new MetricsTracker() }));

    let stats: CategoryMetrics | undefined;
    await atlas.use({
      manifest: { name: "ops", version: "1", capabilities: [], permissions: ["call:approvals", "call:learning"], role: "executor" },
      async register(ctx) {
        const a = (await ctx.call("approvals", { op: "request", action: "Post reel", risk: 2 })) as Approval;
        await ctx.call("approvals", { op: "approve", id: a.id }); // fires approval.granted → learning reflects
        stats = (await ctx.call("learning", { op: "metrics", category: "approval" })) as CategoryMetrics;
      },
    } satisfies Plugin);

    expect(stats?.successes).toBe(1);
  });

  it("surfaces proposals after repeated failures", async () => {
    const atlas = new Atlas({ guardian: new Guardian() });
    await atlas.use(createLearningPlugin({ metrics: new MetricsTracker() }));

    let proposals: Proposal[] = [];
    let reflections: Reflection[] = [];
    await atlas.use({
      manifest: { name: "analyst", version: "1", capabilities: [], permissions: ["call:learning"], role: "executor" },
      async register(ctx) {
        for (let i = 0; i < 4; i++) await ctx.call("learning", { op: "reflect", event: "cold-dm", outcome: "failure", category: "outreach" });
        proposals = (await ctx.call("learning", { op: "proposals" })) as Proposal[];
        reflections = (await ctx.call("learning", { op: "reflections", limit: 10 })) as Reflection[];
      },
    } satisfies Plugin);

    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.category).toBe("outreach");
    expect(reflections.length).toBe(4);
  });
});
