import { describe, it, expect } from "vitest";
import { scoreWinConfidence, matchGigForEmail, WIN_CONFIDENCE_THRESHOLD } from "../src/win-detection";
import type { Gig } from "../src/types";

describe("scoreWinConfidence", () => {
  it("scores a clear win notification at or above the threshold", () => {
    expect(scoreWinConfidence("Congratulations! You've been hired for this project.")).toBeGreaterThanOrEqual(WIN_CONFIDENCE_THRESHOLD);
  });

  it("scores a rejection well below the threshold", () => {
    expect(scoreWinConfidence("Unfortunately we went with another candidate for this one.")).toBeLessThan(WIN_CONFIDENCE_THRESHOLD);
  });

  it("scores a plain question below the threshold", () => {
    expect(scoreWinConfidence("Can you tell me more about your availability?")).toBeLessThan(WIN_CONFIDENCE_THRESHOLD);
  });

  it("clamps to 0-100", () => {
    expect(scoreWinConfidence("")).toBeGreaterThanOrEqual(0);
    expect(scoreWinConfidence("you've been hired congratulations job awarded")).toBeLessThanOrEqual(100);
  });
});

function gig(overrides: Partial<Gig> = {}): Gig {
  return {
    id: "g1",
    source: "web",
    title: "Python scraper for product pages",
    url: "http://x",
    snippet: "scrape data",
    foundAt: "2026-07-01T00:00:00Z",
    status: "submitted",
    dedupeKey: "k1",
    ...overrides,
  };
}

describe("matchGigForEmail", () => {
  it("matches an email that overlaps a pending gig's title", () => {
    const pending = [gig()];
    const match = matchGigForEmail("Congrats, you've been hired for the python scraper project!", pending);
    expect(match?.id).toBe("g1");
  });

  it("returns undefined when nothing overlaps", () => {
    const pending = [gig()];
    const match = matchGigForEmail("Your Amazon order has shipped.", pending);
    expect(match).toBeUndefined();
  });

  it("picks the best-overlapping gig when multiple are pending", () => {
    const pending = [
      gig({ id: "g1", title: "Python scraper for product pages" }),
      gig({ id: "g2", title: "Excel spreadsheet cleanup" }),
    ];
    const match = matchGigForEmail("You're hired! Ready to start the spreadsheet cleanup project.", pending);
    expect(match?.id).toBe("g2");
  });
});
