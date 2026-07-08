import { describe, it, expect } from "vitest";
import { convene } from "../src/index";

describe("Strategy Council", () => {
  it("raises a finance risk when a decision spends money", () => {
    const v = convene("Buy $500 of Instagram ads this week");
    expect(v.risks.join(" ")).toMatch(/finance/);
    expect(v.recommendation).toMatch(/mitigations|Hold/);
  });

  it("reaches a 'for' consensus on safe growth work", () => {
    const v = convene("Post daily Reels content to grow the audience with an automated pipeline");
    expect(v.consensus).toBe("for");
    expect(v.recommendation).toBe("Proceed.");
  });

  it("flags security concerns on risky actions", () => {
    const v = convene("Delete the production credentials and expose the API publicly");
    expect(v.risks.join(" ")).toMatch(/security/);
    expect(v.consensus).not.toBe("for");
  });
});
