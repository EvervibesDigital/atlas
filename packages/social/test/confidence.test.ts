import { describe, it, expect } from "vitest";
import { scoreConfidence } from "../src/confidence";

describe("scoreConfidence", () => {
  it("scores a short, clearly positive message high", () => {
    expect(scoreConfidence("love this!!")).toBeGreaterThanOrEqual(90);
    expect(scoreConfidence("so good, thank you")).toBeGreaterThanOrEqual(90);
  });

  it("scores a question low, regardless of tone", () => {
    expect(scoreConfidence("how much does this cost?")).toBeLessThan(90);
    expect(scoreConfidence("is this real??")).toBeLessThan(90);
  });

  it("scores a long message low", () => {
    const long = "This is a much longer message that goes into detail about a complaint or a complex question that really needs a human to actually read and think about before replying to it properly.";
    expect(scoreConfidence(long)).toBeLessThan(90);
  });

  it("scores a message with negative-sentiment words low", () => {
    expect(scoreConfidence("this is terrible and broken")).toBeLessThan(90);
    expect(scoreConfidence("worst purchase ever, refund now")).toBeLessThan(90);
  });
});
