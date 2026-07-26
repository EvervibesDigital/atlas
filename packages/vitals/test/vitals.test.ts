import { describe, it, expect } from "vitest";
import { computeVitals, STALL_DAYS } from "../src/vitals";
import type { VitalsInput } from "../src/types";

const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

describe("computeVitals", () => {
  it("flags a learning loop that has recorded zero outcomes", () => {
    const input: VitalsInput = { pending: [], knowledge: 10, metrics: [] };
    const { report } = computeVitals(input);
    expect(report.learning.outcomes).toBe(0);
    expect(report.flags.some((f) => /0 outcomes/.test(f))).toBe(true);
    expect(report.healthy).toBe(false);
  });

  it("flags items that have sat unactioned past the stall threshold", () => {
    const input: VitalsInput = {
      pending: [
        { source: "gigfinder", tier: "bulk", createdAt: daysAgo(STALL_DAYS + 4) },
        { source: "gigfinder", tier: "bulk", createdAt: daysAgo(STALL_DAYS + 1) },
        { source: "kdp", tier: "ask", createdAt: daysAgo(0) }, // fresh, not stalled
      ],
      knowledge: 5,
      metrics: [{ category: "x", total: 3, successRate: 0.66 }],
    };
    const { report } = computeVitals(input);
    expect(report.output.stalled).toBe(2);
    expect(report.output.oldestAgeDays).toBeGreaterThanOrEqual(STALL_DAYS + 3);
    expect(report.flags.some((f) => /backing up/.test(f))).toBe(true);
  });

  it("counts pending items by autonomy tier", () => {
    const input: VitalsInput = {
      pending: [
        { source: "leadscan", tier: "bulk" },
        { source: "leadscan", tier: "bulk" },
        { source: "surplus", tier: "ask" },
        { source: "learning", tier: "auto" },
      ],
      knowledge: 1,
      metrics: [{ category: "x", total: 1, successRate: 1 }],
    };
    const { report } = computeVitals(input);
    expect(report.output.byTier).toEqual({ auto: 1, bulk: 2, ask: 1 });
  });

  it("computes growth deltas against the previous snapshot", () => {
    const input: VitalsInput = {
      pending: [{ source: "gigfinder", tier: "bulk" }],
      knowledge: 120,
      metrics: [{ category: "x", total: 5, successRate: 0.8 }],
      prev: { at: daysAgo(1), knowledge: 100, pending: 3, outcomes: 2 },
    };
    const { report } = computeVitals(input);
    expect(report.growth.knowledgeDelta).toBe(20);
    expect(report.growth.pendingDelta).toBe(-2);
    expect(report.learning.outcomesDelta).toBe(3);
  });

  it("flags knowledge that has stopped growing since the last check", () => {
    const input: VitalsInput = {
      pending: [],
      knowledge: 100,
      metrics: [{ category: "x", total: 5, successRate: 0.9 }],
      prev: { at: daysAgo(1), knowledge: 100, pending: 0, outcomes: 5 },
    };
    const { report } = computeVitals(input);
    expect(report.flags.some((f) => /Knowledge hasn't grown/.test(f))).toBe(true);
  });

  it("flags a stalled throughput: items queuing but none completing", () => {
    const input: VitalsInput = {
      pending: [{ source: "gigfinder", tier: "bulk" }, { source: "leadscan", tier: "bulk" }],
      knowledge: 105,
      metrics: [{ category: "x", total: 5, successRate: 0.9 }],
      prev: { at: daysAgo(1), knowledge: 100, pending: 1, outcomes: 5 }, // outcomes unchanged
    };
    const { report } = computeVitals(input);
    expect(report.flags.some((f) => /throughput is stalled/.test(f))).toBe(true);
  });

  it("flags a low overall success rate", () => {
    const input: VitalsInput = {
      pending: [],
      knowledge: 100,
      metrics: [{ category: "outreach", total: 10, successRate: 0.2 }],
      prev: { at: daysAgo(1), knowledge: 100, pending: 0, outcomes: 5 },
    };
    const { report } = computeVitals(input);
    // knowledge-flat flag also fires here; assert the success-rate one specifically.
    expect(report.flags.some((f) => /success rate is low/i.test(f))).toBe(true);
    expect(report.learning.avgSuccessRate).toBeCloseTo(0.2);
  });

  it("is healthy (no flags) when work flows, knowledge grows, and outcomes succeed", () => {
    const input: VitalsInput = {
      pending: [{ source: "kdp", tier: "ask", createdAt: daysAgo(0) }],
      knowledge: 120,
      metrics: [{ category: "x", total: 8, successRate: 0.75 }],
      prev: { at: daysAgo(1), knowledge: 110, pending: 1, outcomes: 6 }, // grew + new outcomes
    };
    const { report } = computeVitals(input);
    expect(report.flags).toEqual([]);
    expect(report.healthy).toBe(true);
  });

  it("returns a snapshot reflecting the current state for next time", () => {
    const input: VitalsInput = {
      pending: [{ source: "kdp" }, { source: "gigfinder" }],
      knowledge: 42,
      metrics: [{ category: "x", total: 7, successRate: 1 }],
    };
    const { snapshot } = computeVitals(input);
    expect(snapshot.knowledge).toBe(42);
    expect(snapshot.pending).toBe(2);
    expect(snapshot.outcomes).toBe(7);
    expect(typeof snapshot.at).toBe("string");
  });

  describe("revenue", () => {
    it("reports mrr as null (not $0) when no revenue bridge is configured", () => {
      const { report, snapshot } = computeVitals({ pending: [], knowledge: 1, metrics: [] });
      expect(report.revenue.mrr).toBeNull();
      expect(report.revenue.mrrDelta).toBeNull();
      expect(snapshot.mrr).toBeUndefined(); // never persists a fake $0
    });

    it("reports real mrr with no delta on the first check (no prior snapshot)", () => {
      const { report, snapshot } = computeVitals({ pending: [], knowledge: 1, metrics: [], mrr: 428 });
      expect(report.revenue.mrr).toBe(428);
      expect(report.revenue.mrrDelta).toBeNull();
      expect(snapshot.mrr).toBe(428);
    });

    it("computes a positive mrrDelta once both snapshots have real revenue", () => {
      const { report } = computeVitals({ pending: [], knowledge: 1, metrics: [], mrr: 500, prev: { at: "x", knowledge: 1, pending: 0, outcomes: 0, mrr: 428 } });
      expect(report.revenue.mrrDelta).toBe(72);
    });

    it("flags a real MRR drop since the last check", () => {
      const { report } = computeVitals({ pending: [], knowledge: 5, metrics: [{ category: "x", total: 3, successRate: 1 }], mrr: 300, prev: { at: "x", knowledge: 5, pending: 0, outcomes: 3, mrr: 400 } });
      expect(report.flags.some((f) => /MRR dropped \$100/.test(f))).toBe(true);
    });

    it("does NOT compute a delta when the previous snapshot predates the revenue bridge (prev.mrr undefined)", () => {
      const { report } = computeVitals({ pending: [], knowledge: 5, metrics: [], mrr: 300, prev: { at: "x", knowledge: 5, pending: 0, outcomes: 0 } });
      expect(report.revenue.mrr).toBe(300);
      expect(report.revenue.mrrDelta).toBeNull(); // no fabricated delta against a snapshot with no real number
    });
  });
});
