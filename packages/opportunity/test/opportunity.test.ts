import { describe, it, expect } from "vitest";
import { scoreOpportunity, rankOpportunities, type Opportunity } from "../src/index";

const highLeverage: Opportunity = { title: "high", description: "", impact: 0.9, effort: 0.2, fit: 0.9 };
const grind: Opportunity = { title: "grind", description: "", impact: 0.5, effort: 0.9, fit: 0.3 };

describe("opportunity scoring", () => {
  it("scores high-impact/low-effort/high-fit above a low-leverage grind", () => {
    expect(scoreOpportunity(highLeverage)).toBeGreaterThan(scoreOpportunity(grind));
  });

  it("ranks and assigns priority tiers", () => {
    const ranked = rankOpportunities([grind, highLeverage]);
    expect(ranked[0]!.title).toBe("high");
    expect(ranked[0]!.priority).toBe("now");
  });
});
