import { describe, it, expect } from "vitest";
import { Atlas, type GuardianLike } from "@atlas/core";
import { createPublishingPlugin } from "../src/plugin";

function permissiveGuardian(): GuardianLike {
  return { grant: () => {}, check: () => ({ decision: "allow", reason: "test" }) };
}

/** Stands in for the approvals service, recording every reject. */
function fakeApprovals(pending: Array<{ id: string; action: string; detail: string; createdAt: string }>) {
  const rejected: string[] = [];
  return {
    rejected,
    plugin: {
      manifest: { name: "approvals", version: "0.0.0", capabilities: ["approvals"], permissions: [], role: "executor" as const },
      async register(ctx: { provide: (n: string, h: (p: unknown) => Promise<unknown>) => void }) {
        ctx.provide("approvals", async (payload) => {
          const cmd = payload as { op: string; id?: string };
          if (cmd.op === "list") return pending;
          if (cmd.op === "reject") { rejected.push(cmd.id!); return { id: cmd.id, status: "rejected" }; }
          if (cmd.op === "request") return { id: "new", status: "pending" };
          throw new Error(`unexpected op ${cmd.op}`);
        });
      },
    },
  };
}

/** Mirrors the real 2026-08-02 queue: one hook 3x, another 2x, one unique. */
function realisticQueue() {
  const A = "Stop trading your hours for dollars.\n\n#aitools";
  const B = "Stop trading your time for money.\n\n#aitools";
  const C = "You are building a prison, not a business.\n\n#aitools";
  return [
    { id: "a1", action: "Post Reel to Instagram (@everspark.ai)", detail: A, createdAt: "2026-08-01T01:00:00Z" },
    { id: "a2", action: "Post Reel to Instagram (@everspark.ai)", detail: A, createdAt: "2026-08-01T02:00:00Z" },
    { id: "b1", action: "Post Reel to Instagram (@everspark.ai)", detail: B, createdAt: "2026-08-01T03:00:00Z" },
    { id: "a3", action: "Post Reel to Instagram (@everspark.ai)", detail: A, createdAt: "2026-08-01T04:00:00Z" },
    { id: "b2", action: "Post Reel to Instagram (@everspark.ai)", detail: B, createdAt: "2026-08-01T05:00:00Z" },
    { id: "c1", action: "Post Reel to Instagram (@everspark.ai)", detail: C, createdAt: "2026-08-01T06:00:00Z" },
    { id: "x1", action: "Send wholesale intro", detail: "unrelated approval", createdAt: "2026-08-01T07:00:00Z" },
  ];
}

async function build(pending: ReturnType<typeof realisticQueue>) {
  const approvals = fakeApprovals(pending);
  const atlas = new Atlas({ guardian: permissiveGuardian() });
  await atlas.use(approvals.plugin as never);
  await atlas.use(createPublishingPlugin({ videoJobsFile: "data/does-not-matter.json" }));
  return { atlas, approvals };
}

describe("publishing.dedupePending", () => {
  it("dry-runs by default — it rejects real queued work", async () => {
    const { atlas, approvals } = await build(realisticQueue());
    const r = (await atlas.invoke("publishing", { op: "dedupePending" })) as {
      dryRun: boolean; pendingReels: number; uniqueHooks: number; duplicates: number; rejected: number;
    };
    expect(r.dryRun).toBe(true);
    expect(r.pendingReels).toBe(6);
    expect(r.uniqueHooks).toBe(3);
    expect(r.duplicates).toBe(3);
    expect(r.rejected).toBe(0);
    expect(approvals.rejected).toEqual([]);
  });

  it("keeps the OLDEST of each hook and rejects the rest", async () => {
    // The first queued is the one whose render has been ready longest.
    const { atlas, approvals } = await build(realisticQueue());
    const r = (await atlas.invoke("publishing", { op: "dedupePending", dryRun: false })) as { rejected: number };
    expect(r.rejected).toBe(3);
    expect(approvals.rejected.sort()).toEqual(["a2", "a3", "b2"]);
    expect(approvals.rejected).not.toContain("a1");
    expect(approvals.rejected).not.toContain("b1");
  });

  it("never touches approvals that are not Reels", async () => {
    const { atlas, approvals } = await build(realisticQueue());
    await atlas.invoke("publishing", { op: "dedupePending", dryRun: false });
    expect(approvals.rejected).not.toContain("x1");
  });

  it("does nothing when every hook is already unique", async () => {
    const unique = realisticQueue().filter((r) => ["a1", "b1", "c1", "x1"].includes(r.id));
    const { atlas, approvals } = await build(unique);
    const r = (await atlas.invoke("publishing", { op: "dedupePending", dryRun: false })) as { duplicates: number };
    expect(r.duplicates).toBe(0);
    expect(approvals.rejected).toEqual([]);
  });
});
