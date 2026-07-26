import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Atlas, ConfigVault } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { createMemoryPlugin, InMemoryStore } from "@atlas/memory";
import { createApprovalsPlugin, ApprovalGateway } from "@atlas/approvals";
import { createLearningPlugin, MetricsTracker } from "@atlas/learning";
import { createBriefPlugin } from "@atlas/brief";
import { createCfoPlugin, type FetchLike } from "@atlas/cfo";
import { createVitalsPlugin } from "../src/plugin";
import type { VitalsReport } from "../src/types";

async function buildAtlas() {
  const atlas = new Atlas({ guardian: new Guardian() });
  await atlas.use(createMemoryPlugin({ store: new InMemoryStore() }));
  await atlas.use(createApprovalsPlugin({ gateway: new ApprovalGateway() }));
  await atlas.use(createLearningPlugin({ metrics: new MetricsTracker() }));
  await atlas.use(createBriefPlugin());
  return atlas;
}

describe("vitals plugin wired through the kernel", () => {
  it("checks its own health from live brief/memory/learning and flags the empty learning loop", async () => {
    const atlas = await buildAtlas();
    await atlas.use(createVitalsPlugin());
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:vitals", "call:memory"], role: "executor" },
      async register(ctx) {
        // Seed some knowledge so growth has a number, but record no outcomes.
        await ctx.call("memory", { op: "remember", input: { kind: "project", content: "scouted repo A" } });
        await ctx.call("memory", { op: "remember", input: { kind: "project", content: "scouted repo B" } });

        const report = (await ctx.call("vitals", { op: "check" })) as VitalsReport;
        expect(report.growth.knowledge).toBe(2);
        expect(report.learning.outcomes).toBe(0);
        expect(report.flags.some((f) => /0 outcomes/.test(f))).toBe(true);
        expect(report.healthy).toBe(false);
      },
    });
  });

  it("persists a snapshot so the next check can compute growth deltas", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-vitals-"));
    const snapshotFile = join(dir, "vitals-snapshot.json");
    try {
      const atlas = await buildAtlas();
      await atlas.use(createVitalsPlugin({ snapshotFile }));
      await atlas.use({
        manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:vitals", "call:memory"], role: "executor" },
        async register(ctx) {
          await ctx.call("memory", { op: "remember", input: { kind: "project", content: "note 1" } });
          await ctx.call("vitals", { op: "check" }); // first check: no prev, knowledge=1

          await ctx.call("memory", { op: "remember", input: { kind: "project", content: "note 2" } });
          await ctx.call("memory", { op: "remember", input: { kind: "project", content: "note 3" } });
          const second = (await ctx.call("vitals", { op: "check" })) as VitalsReport;

          // Second check sees the snapshot from the first and reports the delta.
          expect(second.growth.knowledge).toBe(3);
          expect(second.growth.knowledgeDelta).toBe(2);
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes a timeline memory note only when something is flagged", async () => {
    const atlas = await buildAtlas();
    await atlas.use(createVitalsPlugin());
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:vitals", "call:memory"], role: "executor" },
      async register(ctx) {
        await ctx.call("vitals", { op: "check" }); // 0 outcomes -> flagged
        const notes = (await ctx.call("memory", { op: "recent", kind: "timeline" })) as unknown[];
        expect(notes.length).toBeGreaterThan(0);
      },
    });
  });

  it("picks up real MRR from the cfo bridge when it's wired", async () => {
    const fakeFetch: FetchLike = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ as_of: "x", mrr: 328, one_time_this_month: 0, breakdown: {} }),
    })) as unknown as FetchLike;

    const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({ KDP_CRON_SECRET: "test-secret" }) });
    await atlas.use(createMemoryPlugin({ store: new InMemoryStore() }));
    await atlas.use(createApprovalsPlugin({ gateway: new ApprovalGateway() }));
    await atlas.use(createLearningPlugin({ metrics: new MetricsTracker() }));
    await atlas.use(createBriefPlugin());
    await atlas.use(createCfoPlugin({ fetcher: fakeFetch }));
    await atlas.use(createVitalsPlugin());
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:vitals"], role: "executor" },
      async register(ctx) {
        const report = (await ctx.call("vitals", { op: "check" })) as VitalsReport;
        expect(report.revenue.mrr).toBe(328);
      },
    });
  });

  it("leaves revenue.mrr null when cfo isn't wired at all (no crash)", async () => {
    const atlas = await buildAtlas(); // no cfo plugin registered
    await atlas.use(createVitalsPlugin());
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:vitals"], role: "executor" },
      async register(ctx) {
        const report = (await ctx.call("vitals", { op: "check" })) as VitalsReport;
        expect(report.revenue.mrr).toBeNull();
      },
    });
  });
});
