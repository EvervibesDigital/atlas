import { describe, it, expect } from "vitest";
import { isAiDoable, extractBudget, dedupeKey, scoreCandidate } from "../src/matching";
import { GigRegistry } from "../src/registry";

describe("isAiDoable", () => {
  it("matches relevant keywords", () => {
    expect(isAiDoable("Need a Python scraper built", "scrape 200 product pages")).toBe(true);
    expect(isAiDoable("Dog walker needed", "must walk dogs in person")).toBe(false);
  });

  it("respects exclusion phrases", () => {
    expect(isAiDoable("Automation project", "no AI or bots, humans only please")).toBe(false);
  });
});

describe("extractBudget", () => {
  it("parses dollar amounts", () => {
    expect(extractBudget("Budget: $75 for this task")).toBe(75);
    expect(extractBudget("pays 50 USD")).toBe(50);
    expect(extractBudget("no budget mentioned")).toBeUndefined();
  });
});

describe("dedupeKey", () => {
  it("is stable for the same title+snippet, differs otherwise", () => {
    const a = dedupeKey("Build a scraper", "scrape site X");
    const b = dedupeKey("Build a scraper", "scrape site X");
    const c = dedupeKey("Build a scraper", "scrape site Y");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("scoreCandidate", () => {
  it("rewards budget and urgency", () => {
    const base = scoreCandidate("A job", "desc");
    const withBudget = scoreCandidate("A job", "desc", 200);
    const urgent = scoreCandidate("Urgent job needed", "desc asap");
    expect(withBudget).toBeGreaterThan(base);
    expect(urgent).toBeGreaterThan(base);
  });
});

describe("GigRegistry", () => {
  it("dedupes on addCandidates and persists status changes", async () => {
    const reg = new GigRegistry(); // no file — in-memory only
    const added1 = await reg.addCandidates([{ source: "web", title: "Build scraper", url: "http://a", snippet: "scrape data" }]);
    expect(added1.length).toBe(1);

    const added2 = await reg.addCandidates([{ source: "web", title: "Build scraper", url: "http://a-dup", snippet: "scrape data" }]);
    expect(added2.length).toBe(0);

    const all = await reg.list();
    expect(all.length).toBe(1);
    expect(all[0]!.status).toBe("new");

    const updated = await reg.update(all[0]!.id, { status: "approved", draftBid: "hi" });
    expect(updated?.status).toBe("approved");

    const stats = await reg.stats();
    expect(stats.approved).toBe(1);
    expect(stats.new).toBe(0);
  });

  it("totals paid amounts in stats", async () => {
    const reg = new GigRegistry();
    const [g] = await reg.addCandidates([{ source: "web", title: "Paid job", url: "http://b", snippet: "desc" }]);
    await reg.update(g!.id, { status: "paid", paidAmount: 75 });
    const stats = await reg.stats();
    expect(stats.paid).toBe(1);
    expect(stats.totalEarned).toBe(75);
  });
});
