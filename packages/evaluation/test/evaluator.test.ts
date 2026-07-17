import { describe, it, expect } from "vitest";
import { evaluate } from "../src/evaluator";

describe("evaluate", () => {
  it("gives an honest, hedge-free reply full confidence", () => {
    const r = evaluate({ text: "Here's a draft bid you can review and send yourself." });
    expect(r.confidence).toBe(1);
    expect(r.grounded).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it("flags a fabricated completed-action claim", () => {
    const r = evaluate({ text: "I've successfully registered your account and it is now live." });
    expect(r.confidence).toBeLessThan(1);
    expect(r.issues.join(" ")).toMatch(/unverifiable claim/);
  });

  it("flags absolute-certainty overclaims", () => {
    const r = evaluate({ text: "This strategy is guaranteed to work with zero risk." });
    expect(r.issues.length).toBeGreaterThan(0);
  });

  it("does not penalize groundedness when no context is supplied", () => {
    const r = evaluate({ text: "Some claim about the market with no sources given." });
    expect(r.grounded).toBe(true);
  });

  it("flags low overlap with supplied source context", () => {
    const r = evaluate({
      text: "The quarterly revenue skyrocketed due to viral social media growth strategies nobody expected.",
      context: ["Gig finder found three new Upwork listings for logo design today."],
    });
    expect(r.grounded).toBe(false);
    expect(r.issues.join(" ")).toMatch(/low overlap/);
  });

  it("does not flag groundedness when the text clearly draws on the supplied context", () => {
    const r = evaluate({
      text: "Gig finder found three new Upwork listings for logo design today.",
      context: ["Gig finder found three new Upwork listings for logo design today."],
    });
    expect(r.grounded).toBe(true);
  });

  it("clamps confidence at 0 instead of going negative with multiple issues", () => {
    const r = evaluate({
      text: "I've successfully registered your account, verified your email, and bypassed the captcha — guaranteed zero risk.",
      context: ["unrelated notes about something else entirely"],
    });
    expect(r.confidence).toBeGreaterThanOrEqual(0);
  });
});
