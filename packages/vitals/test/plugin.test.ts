import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Atlas } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { createMemoryPlugin, InMemoryStore } from "@atlas/memory";
import { createApprovalsPlugin, ApprovalGateway } from "@atlas/approvals";
import { createLearningPlugin, MetricsTracker } from "@atlas/learning";
import { createBriefPlugin } from "@atlas/brief";
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
});
