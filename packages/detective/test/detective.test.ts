import { describe, it, expect } from "vitest";
import { investigate } from "../src/index";

describe("investigate", () => {
  it("returns ranked hypotheses (most likely first) with checks", () => {
    const hyps = investigate("sales");
    expect(hyps.length).toBeGreaterThan(0);
    expect(hyps[0]!.likelihood).toBe("high");
    expect(hyps[0]!.check.length).toBeGreaterThan(0);
  });

  it("covers each supported area", () => {
    for (const area of ["sales", "traffic", "rankings", "engagement"] as const) {
      expect(investigate(area).length).toBeGreaterThan(0);
    }
  });
});
