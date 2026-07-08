import { describe, it, expect } from "vitest";
import { planNegotiation } from "../src/index";

describe("planNegotiation", () => {
  it("as a buyer, anchors below target and finds a ZOPA when a deal is possible", () => {
    const plan = planNegotiation({ role: "buyer", target: 1000, walkaway: 1400, theirLikely: 1200 });
    expect(plan.opening).toBeLessThan(plan.target);
    expect(plan.zopa).toEqual([1200, 1400]); // seller likely 1200 ≤ our max 1400
  });

  it("returns no ZOPA when the buyer can't reach the seller's price", () => {
    const plan = planNegotiation({ role: "buyer", target: 500, walkaway: 800, theirLikely: 1000 });
    expect(plan.zopa).toBeNull();
  });

  it("as a seller, anchors above target", () => {
    const plan = planNegotiation({ role: "seller", target: 1000, walkaway: 800, theirLikely: 900 });
    expect(plan.opening).toBeGreaterThan(plan.target);
    expect(plan.zopa).toEqual([800, 900]);
  });
});
