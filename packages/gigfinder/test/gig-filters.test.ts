import { describe, it, expect } from "vitest";
import { isEmploymentPosting, isAncientRedditPost, isJunkTitle, isRealGigCandidate, wordPresent } from "../src/matching";

/**
 * Every string here is VERBATIM from the live gig queue on 2026-08-02, where
 * 58 pending gigs included 6 salaried roles, 5 boilerplate titles, and 3 posts
 * from 2020-2022. Mat's actual requirement: "quick fast easy jobs ATLAS can
 * do" — a months-long staff hire is the opposite of that.
 */
describe("isEmploymentPosting", () => {
  it("rejects the real full-time roles that were in the queue", () => {
    expect(isEmploymentPosting("[Hiring] Senior Full-Stack Engineers | Next.js + Python/FastAPI | Remote", "")).toBe(true);
    expect(isEmploymentPosting("[Hiring] Go/Golang job: Senior Software Engineer", "")).toBe(true);
    // Note: the salary wording lives in the snippet, which is deliberately
    // ignored (listing pages mix postings). This one is caught by the
    // ancient-post filter instead — it is a 2020 listing.
    expect(isAncientRedditPost("https://www.reddit.com/r/jobbit/comments/jl9jva/hiring_machine")).toBe(true);
  });

  it("keeps the real short gigs that were in the same queue", () => {
    expect(isEmploymentPosting("[Hiring] $15/hr – Simple OpenAI API Integration into Search UI", "")).toBe(false);
    expect(isEmploymentPosting("[Hiring] Telegram Bot + Simple Website Developer", "")).toBe(false);
    expect(isEmploymentPosting("[Hiring] Need someone to code a script that automates a report", "")).toBe(false);
  });

  it("keeps a senior-titled post when the budget is IN THE TITLE", () => {
    // "Senior developer wanted, $400" is a gig, not a career.
    expect(isEmploymentPosting("Senior developer wanted for a 2-day script, $400", "")).toBe(false);
  });

  it("ACCEPTED TRADE-OFF: a senior title with the budget only in the body is rejected", () => {
    // Reading the snippet is not an option — listing pages mix several
    // postings together, which wrongly pruned a real $15/hr gig. So a
    // seniority word in the title with no figure beside it is treated as a
    // staff role. Mat loses the occasional well-paid senior-titled gig; the
    // alternative was silently deleting short gigs he wanted. Pinned so the
    // trade-off is a decision on the record, not a surprise.
    expect(isEmploymentPosting("Senior developer wanted for a 2-day script", "budget $400")).toBe(true);
  });
});

describe("isAncientRedditPost", () => {
  it("rejects the pre-2023 posts found in the queue", () => {
    // jl9jva ≈ 2020 (State Farm), ujiy9p ≈ 2022 — both long dead.
    expect(isAncientRedditPost("https://www.reddit.com/r/jobbit/comments/jl9jva/hiring_machine")).toBe(true);
    expect(isAncientRedditPost("https://www.reddit.com/r/forhire/comments/ujiy9p/hiring_need")).toBe(true);
  });

  it("keeps the 7-char ids that made up 55 of 58 real gigs", () => {
    expect(isAncientRedditPost("https://www.reddit.com/r/jobbit/comments/1lux3ta/hiring_looking")).toBe(false);
    expect(isAncientRedditPost("https://www.reddit.com/r/jobbit/comments/1ogiccp/hiring_me_a")).toBe(false);
  });

  it("says nothing about non-Reddit urls rather than guessing", () => {
    expect(isAncientRedditPost("https://news.ycombinator.com/item?id=123")).toBe(false);
  });
});

describe("isJunkTitle", () => {
  it("rejects the boilerplate title that appeared 5 times", () => {
    expect(isJunkTitle("Reddit - The heart of the internet")).toBe(true);
  });

  it("keeps a real posting title", () => {
    expect(isJunkTitle("[Hiring] Telegram Bot + Simple Website Developer")).toBe(false);
  });
});

describe("isRealGigCandidate — the single gate every path uses", () => {
  const goodUrl = "https://www.reddit.com/r/forhire/comments/1lux3ta/hiring_x";

  it("accepts a real short gig", () => {
    expect(isRealGigCandidate("[Hiring] Need a Python script to automate a report", "budget $200, api integration", goodUrl)).toBe(true);
  });

  it("rejects a salaried role even when the text is otherwise perfect", () => {
    expect(isRealGigCandidate("[Hiring] Senior Software Engineer", "python automation api, full-time with benefits", goodUrl)).toBe(false);
  });

  it("rejects an ancient posting even when the text is perfect", () => {
    const oldUrl = "https://www.reddit.com/r/forhire/comments/ujiy9p/hiring_x";
    expect(isRealGigCandidate("[Hiring] Need a Python script to automate a report", "budget $200, api", oldUrl)).toBe(false);
  });

  it("rejects boilerplate titles before anything else runs", () => {
    expect(isRealGigCandidate("Reddit - The heart of the internet", "python automation api hiring budget $200", goodUrl)).toBe(false);
  });
});

// ── pruneQueue: apply the filters to gigs already stored ───────────────────
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Atlas, ConfigVault, type GuardianLike } from "@atlas/core";
import { createGigFinderPlugin } from "../src/plugin";
import type { Gig } from "../src/types";

function gig(id: string, over: Partial<Gig>): Gig {
  return {
    id, source: "web", title: `Job ${id}`, url: "https://www.reddit.com/r/forhire/comments/1lux3ta/x",
    snippet: "", foundAt: "2026-08-01T00:00:00.000Z", status: "new", dedupeKey: id, draftBid: "x",
    ...over,
  } as Gig;
}

describe("gigfinder.pruneQueue", () => {
  async function atlasWith(gigs: Gig[], file: string) {
    await writeFile(file, JSON.stringify(gigs), "utf8");
    const a = new Atlas({
      guardian: { grant: () => {}, check: () => ({ decision: "allow", reason: "t" }) } as GuardianLike,
      config: new ConfigVault({}),
    });
    await a.use(createGigFinderPlugin({ gigFile: file }));
    return a;
  }

  it("dry-runs by default and finds the three real defect classes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-prune-"));
    const file = join(dir, "gigs.json");
    try {
      const a = await atlasWith([
        gig("keep", { title: "[Hiring] Need a Python script to automate a report", snippet: "budget $200" }),
        gig("ft", { title: "[Hiring] Senior Full-Stack Engineers | Next.js + Python/FastAPI | Remote" }),
        gig("junk", { title: "Reddit - The heart of the internet" }),
        gig("old", { url: "https://www.reddit.com/r/jobbit/comments/jl9jva/hiring_ml" }),
      ], file);

      const r = (await a.invoke("gigfinder", { op: "pruneQueue" })) as { dryRun: boolean; matched: number; removed: number };
      expect(r.dryRun).toBe(true);
      expect(r.matched).toBe(3);
      expect(r.removed).toBe(0);

      const onDisk = JSON.parse(await readFile(file, "utf8")) as Gig[];
      expect(onDisk.every((g) => g.status === "new")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects the bad ones and leaves the good gig untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-prune-"));
    const file = join(dir, "gigs.json");
    try {
      const a = await atlasWith([
        gig("keep", { title: "[Hiring] Need a Python script to automate a report", snippet: "budget $200" }),
        gig("ft", { title: "[Hiring] Senior Full-Stack Engineers | Next.js + Python/FastAPI | Remote" }),
      ], file);
      const r = (await a.invoke("gigfinder", { op: "pruneQueue", dryRun: false })) as { removed: number };
      expect(r.removed).toBe(1);

      const onDisk = JSON.parse(await readFile(file, "utf8")) as Gig[];
      expect(onDisk.find((g) => g.id === "keep")!.status).toBe("new");
      expect(onDisk.find((g) => g.id === "ft")!.status).toBe("rejected");
      expect(onDisk.find((g) => g.id === "ft")!.notes).toMatch(/salaried/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never rewrites a gig that was already submitted", async () => {
    // A submitted bid is history; rewriting it hides what actually happened.
    const dir = await mkdtemp(join(tmpdir(), "atlas-prune-"));
    const file = join(dir, "gigs.json");
    try {
      const a = await atlasWith([
        gig("sent", { title: "Reddit - The heart of the internet", status: "submitted", submittedAt: "2026-08-01T00:00:00.000Z" }),
      ], file);
      const r = (await a.invoke("gigfinder", { op: "pruneQueue", dryRun: false })) as { examined: number; removed: number };
      expect(r.examined).toBe(0);
      expect(r.removed).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("wordPresent — the substring bug that flagged real gigs", () => {
  it('does not let "pto" match inside "crypto"', () => {
    // Live queue: crypto-bot gigs were being rejected as salaried employment
    // because "pto" (paid time off) is a substring of "crypto".
    expect(wordPresent("build me a crypto trading bot", "pto")).toBe(false);
    expect(wordPresent("generous pto and benefits", "pto")).toBe(true);
  });

  it("handles signals containing regex metacharacters", () => {
    // "full-time" and "part-time employee" contain '-', which broke an
    // inline-escaped RegExp twice.
    expect(wordPresent("this is a full-time role", "full-time")).toBe(true);
    expect(wordPresent("a fullXtime role", "full-time")).toBe(false);
  });
});

describe("isEmploymentPosting reads the TITLE only", () => {
  it("ignores employment words that leaked in from another posting", () => {
    // Reddit search snippets are LISTING PAGES: several jobs in one string.
    // This exact gig was wrongly pruned because a different job further down
    // the same page said "full-time".
    const title = "[Hiring] $15/hr – Simple OpenAI API Integration into Search UI (fast 2-hour task)";
    const contaminatedSnippet = "... another post: senior engineer, full-time with benefits package ...";
    expect(isEmploymentPosting(title, contaminatedSnippet)).toBe(false);
  });

  it("still catches a salaried role from its own title", () => {
    expect(isEmploymentPosting("[Hiring] 🐍 Senior Python Developer - 📍 Fully Remote", "")).toBe(true);
  });

  it("treats an annual-scale figure as a salary, not a project budget", () => {
    // Gig budgets in the real queue run $15-$500. A five-figure number is a
    // yearly package.
    expect(isEmploymentPosting("[HIRING] Embedded Systems Software Developer [💰 101420]", "")).toBe(true);
    expect(isEmploymentPosting("[Hiring] Python script, budget $400", "")).toBe(false);
  });
});

describe("long engagements are not quick gigs", () => {
  it("rejects a multi-week contract even though it quotes an hourly rate", () => {
    // Verbatim from the live queue. The dollar sign made a budget-based rule
    // keep it, but twelve weeks is the opposite of what Mat asked for.
    expect(isEmploymentPosting("[Hiring] Senior Full-Stack Engineers | Next.js + Python/FastAPI | Remote | $20–$25/hr | 12+ Weeks", "")).toBe(true);
  });

  it("catches a seniority title needing TWO qualifier words", () => {
    // "Senior Embedded Software Developer" — one optional qualifier was not
    // enough, so this survived the first prune.
    expect(isEmploymentPosting("[HIRING] Senior Embedded Software Developer", "")).toBe(true);
  });

  it("still keeps a genuinely short paid task", () => {
    expect(isEmploymentPosting("[Hiring] $15/hr – Simple OpenAI API Integration into Search UI (fast 2-hour task)", "")).toBe(false);
    expect(isEmploymentPosting("[Hiring] Telegram Bot + Simple Website Developer", "")).toBe(false);
    expect(isEmploymentPosting("[Hiring] Need a Python script, budget $400, delivery in 3 days", "")).toBe(false);
  });
});
