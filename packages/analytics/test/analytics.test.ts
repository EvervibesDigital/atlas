import { describe, it, expect } from "vitest";
import { computeKpis, type MetricRow } from "../src/index";

const rows: MetricRow[] = [
  { category: "reels", successes: 8, failures: 2, total: 10, successRate: 0.8 },
  { category: "outreach", successes: 1, failures: 9, total: 10, successRate: 0.1 },
  { category: "empty", successes: 0, failures: 0, total: 0, successRate: 0 },
];

describe("computeKpis", () => {
  it("summarizes overall rate and best/worst categories", () => {
    const k = computeKpis(rows);
    expect(k.totalActions).toBe(20);
    expect(k.overallSuccessRate).toBeCloseTo(0.45);
    expect(k.topCategory).toBe("reels");
    expect(k.weakestCategory).toBe("outreach");
    expect(k.categoriesTracked).toBe(2); // the empty one is excluded
  });

  it("handles no data gracefully", () => {
    const k = computeKpis([]);
    expect(k.overallSuccessRate).toBe(0);
    expect(k.topCategory).toBeNull();
  });
});
