import { describe, it, expect } from "vitest";
import { isUsableBid, renderFallbackBid } from "../src/templates";

describe("isUsableBid", () => {
  it("rejects the exact broken bid found in production", () => {
    // This was stored and shown as a real pitch on a live gig (2026-08-01).
    expect(isUsableBid("Delivery Estimate):* Depending on your clients'")).toBe(false);
  });

  it("rejects other real-world failure shapes", () => {
    expect(isUsableBid("")).toBe(false);
    expect(isUsableBid("   ")).toBe(false);
    // Too short to be the 3-5 sentences the prompt asks for.
    expect(isUsableBid("I will develop custom automation scripts")).toBe(false);
    // Leaked markdown scaffolding.
    expect(isUsableBid("**Pitch:** I can build the automation you need using Python and the relevant APIs, delivered inside five business days.")).toBe(false);
    // Starts mid-sentence.
    expect(isUsableBid("and I would deliver the finished automation within five business days, using Python and the relevant platform APIs to wire it together.")).toBe(false);
    // Cut off mid-sentence by a token limit.
    expect(isUsableBid("I can build the custom API integration you described, using Python and a secure REST design so your systems talk to each other without manual")).toBe(false);
  });

  it("accepts a genuine pitch", () => {
    const good =
      "I can build the Telegram bot and simple site you described. I'd use Python with the Telegram Bot API for the bot, and a lightweight static front end for the site. Expect a working version in 3-5 business days, with the source handed over.";
    expect(isUsableBid(good)).toBe(true);
  });

  it("accepts a pitch that ends on a quote or closing bracket", () => {
    expect(
      isUsableBid(
        'I can automate the CSV cleanup end to end using Python and pandas, then schedule it so it runs weekly without you touching it. Delivery in about three business days. Happy to start with a small paid test first, if you would rather "try before you buy."',
      ),
    ).toBe(true);
  });

  it("every fallback template it falls back TO is itself usable", () => {
    // Otherwise rejecting a bad model output would just swap one unusable
    // bid for another.
    for (const source of ["web", "fiverr", "guru"] as const) {
      const bid = renderFallbackBid(source, "Python + Playwright Developer for Automation", 400);
      expect(isUsableBid(bid), `${source} fallback should be usable: ${bid}`).toBe(true);
    }
  });
});
