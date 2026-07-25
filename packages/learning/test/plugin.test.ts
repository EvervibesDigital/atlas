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

  it("adopt() writes a standing directive to memory and stops the proposal from resurfacing", async () => {
    const atlas = new Atlas({ guardian: new Guardian() });
    await atlas.use(createMemoryPlugin({ store: new InMemoryStore() }));
    await atlas.use(createLearningPlugin({ metrics: new MetricsTracker() }));

    await atlas.use({
      manifest: { name: "ops", version: "1", capabilities: [], permissions: ["call:learning", "call:memory"], role: "executor" },
      async register(ctx) {
        for (let i = 0; i < 4; i++) await ctx.call("learning", { op: "reflect", event: "cold-dm", outcome: "failure", category: "outreach" });

        const before = (await ctx.call("learning", { op: "proposals" })) as Proposal[];
        expect(before).toHaveLength(1);

        const result = (await ctx.call("learning", { op: "adopt", category: "outreach" })) as { ok: boolean; message: string };
        expect(result.ok).toBe(true);
        expect(result.message).toMatch(/standing directive/);

        // "recent" by kind, not "search" — the default stub embedder in tests
        // doesn't do real semantic filtering (it scores every record, so a
        // keyword "search" would also match the 4 unrelated failure lessons
        // recorded above). Filtering by kind:"directive" is exact.
        const directives = (await ctx.call("memory", { op: "recent", kind: "directive" })) as unknown[];
        expect(directives.length).toBe(1);

        const after = (await ctx.call("learning", { op: "proposals" })) as Proposal[];
        expect(after).toHaveLength(0);
      },
    } satisfies Plugin);
  });

  it("dismiss() suppresses the proposal without touching memory", async () => {
    const atlas = new Atlas({ guardian: new Guardian() });
    await atlas.use(createMemoryPlugin({ store: new InMemoryStore() }));
    await atlas.use(createLearningPlugin({ metrics: new MetricsTracker() }));

    await atlas.use({
      manifest: { name: "ops", version: "1", capabilities: [], permissions: ["call:learning", "call:memory"], role: "executor" },
      async register(ctx) {
        for (let i = 0; i < 4; i++) await ctx.call("learning", { op: "reflect", event: "cold-dm", outcome: "failure", category: "outreach" });

        await ctx.call("learning", { op: "dismiss", category: "outreach" });

        const directives = (await ctx.call("memory", { op: "recent", kind: "directive" })) as unknown[];
        expect(directives.length).toBe(0);

        const after = (await ctx.call("learning", { op: "proposals" })) as Proposal[];
        expect(after).toHaveLength(0);
      },
    } satisfies Plugin);
  });

  it("adopt() throws a clear error for a category with no current metrics", async () => {
    const atlas = new Atlas({ guardian: new Guardian() });
    await atlas.use(createMemoryPlugin({ store: new InMemoryStore() }));
    await atlas.use(createLearningPlugin({ metrics: new MetricsTracker() }));

    await atlas.use({
      manifest: { name: "ops", version: "1", capabilities: [], permissions: ["call:learning"], role: "executor" },
      async register(ctx) {
        await expect(ctx.call("learning", { op: "adopt", category: "nonexistent" })).rejects.toThrow(/no metrics/);
      },
    } satisfies Plugin);
  });
});
