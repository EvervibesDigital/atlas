import { describe, it, expect } from "vitest";
import { MetricsTracker } from "../src/metrics";
import { reflect } from "../src/reflection";
import { generateProposals } from "../src/proposals";

describe("MetricsTracker", () => {
  it("tracks success rate and smoothed confidence", async () => {
    const m = new MetricsTracker();
    await m.record("reels", "success");
    await m.record("reels", "success");
    await m.record("reels", "failure");
    const stats = await m.get("reels");
    expect(stats.total).toBe(3);
    expect(stats.successRate).toBeCloseTo(2 / 3);
    expect(stats.confidence).toBeCloseTo(3 / 5); // (2+1)/(3+2)
  });

  it("reports 0.5 confidence for an unknown category (no data)", async () => {
    const m = new MetricsTracker();
    expect((await m.get("new")).confidence).toBe(0.5);
  });
});

describe("reflect", () => {
  it("writes a clear success lesson", () => {
    const r = reflect({ event: "reel.published", outcome: "success", category: "@everspark.ai", detail: "8am post" });
    expect(r.outcome).toBe("success");
    expect(r.lesson).toMatch(/worked for @everspark\.ai/);
  });
  it("writes a failure lesson with the reason", () => {
    const r = reflect({ event: "post", outcome: "failure", category: "x", detail: "rate limited" });
    expect(r.lesson).toMatch(/failed for x: rate limited/);
  });
});

describe("generateProposals", () => {
  it("flags an underperforming category with enough samples", async () => {
    const m = new MetricsTracker();
    for (let i = 0; i < 4; i++) await m.record("dm-outreach", "failure");
    await m.record("dm-outreach", "success");
    const proposals = generateProposals(await m.all());
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.category).toBe("dm-outreach");
    expect(proposals[0]!.status).toBe("open");
  });

  it("ignores healthy categories and tiny samples", async () => {
    const m = new MetricsTracker();
    await m.record("good", "success");
    await m.record("good", "success");
    await m.record("good", "success");
    await m.record("tiny", "failure"); // only 1 sample
    expect(generateProposals(await m.all())).toHaveLength(0);
  });
});
