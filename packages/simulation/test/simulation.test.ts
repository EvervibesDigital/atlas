import { describe, it, expect } from "vitest";
import { simulate, compareScenarios } from "../src/index";

describe("simulate", () => {
  it("compounds weekly growth", () => {
    const r = simulate({ startValue: 100, weeklyGrowthPct: 10, weeks: 2 });
    expect(r.series).toEqual([110, 121]);
    expect(r.finalValue).toBe(121);
  });
});

describe("compareScenarios", () => {
  it("recommends the higher-growth variant", () => {
    const c = compareScenarios(
      { label: "3x/week", startValue: 1000, weeklyGrowthPct: 3, weeks: 12 },
      { label: "daily", startValue: 1000, weeklyGrowthPct: 6, weeks: 12 },
    );
    expect(c.recommend).toBe("variant");
    expect(c.deltaPct).toBeGreaterThan(0);
  });
});
