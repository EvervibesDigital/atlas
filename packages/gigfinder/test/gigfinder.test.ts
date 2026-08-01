import { describe, it, expect } from "vitest";
import { isAiDoable, isSpecificPosting, isRealGigCandidate, extractBudget, dedupeKey, scoreCandidate } from "../src/matching";
import { GigRegistry } from "../src/registry";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Atlas, ConfigVault } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { createGigFinderPlugin } from "../src/plugin";

/**
 * These URLs and titles are the REAL strings pulled from production
 * gigs.json on 2026-08-01, where 128 of 128 "approved" gigs turned out to
 * be landing/category/search pages rather than job postings. They're kept
 * verbatim rather than invented so this suite pins the actual failure.
 */
describe("isSpecificPosting", () => {
  it("accepts a real Reddit posting permalink", () => {
    expect(isSpecificPosting("https://www.reddit.com/r/n8n/comments/1kxz8k1/looking_for_automation_and_ai_freelancers_and")).toBe(true);
  });

  it("rejects the marketing/category/search pages that flooded the queue", () => {
    expect(isSpecificPosting("https://digiscorp.com/hire-api-developers")).toBe(false);
    expect(isSpecificPosting("https://www.guru.com/m/hire/freelancers/api-developers")).toBe(false);
    expect(isSpecificPosting("https://www.freelancer.com/hire/scripting")).toBe(false);
    expect(isSpecificPosting("https://www.youtube.com/watch?v=cZccCaa_BgQ")).toBe(false);
    expect(isSpecificPosting("https://www.ziprecruiter.com/Jobs/Freelance-Automation")).toBe(false);
  });

  it("does NOT let the /hire/ category signal reject r/forhire permalinks", () => {
    // r/forhire is the single best source in the query set — "forhire" has no
    // slash before "hire", so it must not trip the category filter.
    expect(isSpecificPosting("https://www.reddit.com/r/forhire/comments/1abc234/hiring_python_automation_dev")).toBe(true);
  });

  it("accepts a numeric posting id and rejects a malformed URL without throwing", () => {
    expect(isSpecificPosting("https://newyork.craigslist.org/d/software/7891234567.html")).toBe(true);
    expect(isSpecificPosting("not a url")).toBe(false);
  });
});

describe("isRealGigCandidate", () => {
  it("requires BOTH readable hiring intent and a specific-posting URL", () => {
    const realTitle = "Need a Python scraper built";
    const realSnippet = "scrape 200 product pages";
    expect(isRealGigCandidate(realTitle, realSnippet, "https://www.reddit.com/r/forhire/comments/1abc234/x")).toBe(true);
    // Same convincing text, but the URL is a category page — still rejected.
    expect(isRealGigCandidate(realTitle, realSnippet, "https://www.freelancer.com/hire/scripting")).toBe(false);
  });
});

describe("isAiDoable", () => {
  it("does not let 'hire a' substring-match 'hire api' (real production false positive)", () => {
    // "hire api developers online".includes("hire a") === true — the naive
    // substring check is what let Guru's landing page through as a "gig".
    expect(
      isAiDoable(
        "Hire API Developers Online",
        "API development is the process of creating and maintaining application programming interfaces (APIs) that allow different software systems to communic",
      ),
    ).toBe(false);
  });

  it("matches relevant keywords", () => {
    expect(isAiDoable("Need a Python scraper built", "scrape 200 product pages")).toBe(true);
    expect(isAiDoable("Dog walker needed", "must walk dogs in person")).toBe(false);
  });

  it("respects exclusion phrases", () => {
    expect(isAiDoable("Automation project", "no AI or bots, humans only please")).toBe(false);
  });

  it("rejects [FOR HIRE] self-advertisements — same keywords, inverted direction", () => {
    // Caught live on 2026-08-01: a real scan surfaced this alongside genuine
    // [Hiring] posts. It's a freelancer offering services, not a job.
    expect(isAiDoable("[FOR HIRE] Python Developer -> Scripting, Automation, Bots", "Experienced dev available for automation and scraping work.")).toBe(false);
    // ...while the genuine [Hiring] post in the same subreddit still passes.
    expect(isAiDoable("[HIRING] Python + Playwright Developer for Automation", "Need someone to build a scraper, budget: $400")).toBe(true);
  });

  it("rejects pricing/discussion content even when it hits the same keywords a real posting would", () => {
    // These are the exact false-positive shape Mat flagged: real automation
    // vocabulary, zero actual hiring intent — an article, not a job.
    expect(isAiDoable("How Much Does Automation Cost for Small Businesses?", "A guide to pricing custom API integrations and workflow scripts.")).toBe(false);
    expect(isAiDoable("What freelancers charge for web scraping in 2026", "Average rate for scraping projects, by experience level.")).toBe(false);
    expect(isAiDoable("The Ultimate Guide to Freelance Automation Pricing", "How to price your automation and bot-building services.")).toBe(false);
  });

  it("accepts real postings that open with 'need a/an/someone' without hardcoding every profession", () => {
    expect(isAiDoable("Need someone to build a chatbot", "Small budget, quick turnaround.")).toBe(true);
    expect(isAiDoable("Need an automation script", "For a Shopify store, budget: $100")).toBe(true);
    expect(isAiDoable("Looking to hire a developer", "for API integration work")).toBe(true);
  });

  it("still requires an AI-doable keyword even with hiring intent present", () => {
    expect(isAiDoable("Hiring a dog walker", "need someone reliable, budget: $30/walk")).toBe(false);
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

describe("gigfinder plugin checkWins", () => {
  function fakeEmail(messages: Array<{ from: string; subject: string; date: string; text: string; links: string[] }>) {
    return {
      manifest: { name: "email", version: "1", capabilities: ["email"], permissions: [], role: "executor" as const },
      register(ctx: { provide: (name: string, fn: (payload: unknown) => Promise<unknown>) => void }) {
        ctx.provide("email", async (payload: unknown) => {
          const cmd = payload as { op: string };
          if (cmd.op === "check") return { messages };
          throw new Error("unexpected email op in test: " + cmd.op);
        });
      },
    };
  }

  async function seedSubmittedGig(gigFile: string, title: string): Promise<string> {
    const reg = new GigRegistry(gigFile);
    const [added] = await reg.addCandidates([{ source: "web", title, url: "http://x", snippet: "desc" }]);
    await reg.update(added!.id, { status: "submitted" });
    return added!.id;
  }

  it("marks a gig won on a confident match and does nothing else", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-gigfinder-wins-"));
    const gigFile = join(dir, "gigs.json");
    try {
      const gigId = await seedSubmittedGig(gigFile, "Python scraper for product pages");
      const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({}) });
      await atlas.use(
        fakeEmail([{ from: "client@example.com", subject: "You're hired!", date: "2026-07-30T00:00:00Z", text: "Congratulations, you've been hired for the python scraper project.", links: [] }]),
      );
      await atlas.use(createGigFinderPlugin({ gigFile }));
      await atlas.use({
        manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:gigfinder"], role: "executor" },
        async register(ctx) {
          const r = (await ctx.call("gigfinder", { op: "checkWins" })) as { checked: number; won: number; flagged: number };
          expect(r.won).toBe(1);
          expect(r.flagged).toBe(0);
          const gig = await ctx.call("gigfinder", { op: "list", status: "won" });
          expect((gig as Array<{ id: string }>).map((g) => g.id)).toContain(gigId);
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("flags an ambiguous reply as responded instead of guessing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-gigfinder-wins-"));
    const gigFile = join(dir, "gigs.json");
    try {
      await seedSubmittedGig(gigFile, "Python scraper for product pages");
      const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({}) });
      await atlas.use(
        fakeEmail([{ from: "client@example.com", subject: "Quick question", date: "2026-07-30T00:00:00Z", text: "Can you tell me more about the python scraper timeline?", links: [] }]),
      );
      await atlas.use(createGigFinderPlugin({ gigFile }));
      await atlas.use({
        manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:gigfinder"], role: "executor" },
        async register(ctx) {
          const r = (await ctx.call("gigfinder", { op: "checkWins" })) as { checked: number; won: number; flagged: number };
          expect(r.won).toBe(0);
          expect(r.flagged).toBe(1);
          const responded = (await ctx.call("gigfinder", { op: "list", status: "responded" })) as Array<{ notes?: string }>;
          expect(responded).toHaveLength(1);
          expect(responded[0]!.notes).toContain("python scraper timeline");
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips calling email.check when there are no submitted gigs to match against", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-gigfinder-wins-"));
    const gigFile = join(dir, "gigs.json");
    try {
      const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({}) });
      let emailChecked = false;
      await atlas.use({
        manifest: { name: "email", version: "1", capabilities: ["email"], permissions: [], role: "executor" },
        register(ctx) {
          ctx.provide("email", async () => { emailChecked = true; return { messages: [] }; });
        },
      });
      await atlas.use(createGigFinderPlugin({ gigFile }));
      await atlas.use({
        manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:gigfinder"], role: "executor" },
        async register(ctx) {
          const r = (await ctx.call("gigfinder", { op: "checkWins" })) as { checked: number; won: number; flagged: number };
          expect(r).toEqual({ checked: 0, won: 0, flagged: 0 });
        },
      });
      expect(emailChecked).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("doesn't let a later, lower-confidence email in the same batch downgrade a gig already marked won", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-gigfinder-wins-"));
    const gigFile = join(dir, "gigs.json");
    try {
      const gigId = await seedSubmittedGig(gigFile, "Python scraper for product pages");
      const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({}) });
      await atlas.use(
        fakeEmail([
          { from: "client@example.com", subject: "You're hired!", date: "2026-07-30T00:00:00Z", text: "Congratulations, you've been hired for the python scraper project.", links: [] },
          { from: "client@example.com", subject: "Quick follow-up", date: "2026-07-30T01:00:00Z", text: "Can you confirm the python scraper timeline?", links: [] },
        ]),
      );
      await atlas.use(createGigFinderPlugin({ gigFile }));
      await atlas.use({
        manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:gigfinder"], role: "executor" },
        async register(ctx) {
          const r = (await ctx.call("gigfinder", { op: "checkWins" })) as { checked: number; won: number; flagged: number };
          expect(r.checked).toBe(2);
          expect(r.won).toBe(1);
          expect(r.flagged).toBe(0); // the second email must NOT re-match and downgrade the already-won gig
          const won = (await ctx.call("gigfinder", { op: "list", status: "won" })) as Array<{ id: string }>;
          expect(won.map((g) => g.id)).toContain(gigId);
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("gigfinder plugin approve on a responded gig", () => {
  it("marks a responded gig won instead of drafting a new bid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-gigfinder-approve-won-"));
    const gigFile = join(dir, "gigs.json");
    try {
      const reg = new GigRegistry(gigFile);
      const [added] = await reg.addCandidates([{ source: "web", title: "Excel cleanup job", url: "http://x", snippet: "desc" }]);
      await reg.update(added!.id, { status: "responded", notes: "Congrats, you're hired!" });

      const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({}) });
      await atlas.use(createGigFinderPlugin({ gigFile }));
      await atlas.use({
        manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:gigfinder"], role: "executor" },
        async register(ctx) {
          const r = (await ctx.call("gigfinder", { op: "approve", id: added!.id })) as { status: string };
          expect(r.status).toBe("won");
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
