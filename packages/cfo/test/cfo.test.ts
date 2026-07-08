import { describe, it, expect } from "vitest";
import { forecast, roi } from "../src/index";

describe("forecast", () => {
  it("reports infinite runway and healthy when cash-flow positive", () => {
    const f = forecast({ cashOnHand: 5000, monthlyRevenue: 3000, monthlyExpenses: 2000 });
    expect(f.netMonthly).toBe(1000);
    expect(f.runwayMonths).toBeNull();
    expect(f.verdict).toBe("healthy");
    expect(f.sixMonthProjection.at(-1)).toBe(11000);
  });

  it("flags critical when runway is under 3 months", () => {
    const f = forecast({ cashOnHand: 2000, monthlyRevenue: 500, monthlyExpenses: 1500 });
    expect(f.runwayMonths).toBe(2);
    expect(f.verdict).toBe("critical");
  });
});

describe("roi", () => {
  it("computes a positive ROI ratio", () => {
    expect(roi(100, 250)).toBe(1.5);
  });
  it("rejects a non-positive cost", () => {
    expect(() => roi(0, 100)).toThrow(/positive/);
  });
});
