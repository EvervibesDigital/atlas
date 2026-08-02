import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Atlas, type GuardianLike } from "@atlas/core";
import { templateWorkPackage, buildHandoffPrompt, isUsableWorkPackage, type WorkPackage, isUsableBid, bidProblem } from "../src/work-package";
import { createGigFinderPlugin } from "../src/plugin";
import { GigRegistry } from "../src/registry";
import type { Gig } from "../src/types";

function permissiveGuardian(): GuardianLike {
  return { grant: () => {}, check: () => ({ decision: "allow", reason: "test" }) };
}

/** Modelled on a REAL gig now in the live queue (r/forhire, 2026-08-01). */
const GIG: Gig = {
  id: "g1",
  source: "web",
  title: "[Hiring] Telegram Bot + Simple Website Developer",
  url: "https://www.reddit.com/r/forhire/comments/1saidti/hiring_telegram_bot_simple_website_developer_for",
  snippet: "Need someone to build a Telegram bot that takes orders and a simple website to go with it. Budget flexible for the right person.",
  budget: 500,
  foundAt: "2026-08-01T00:00:00.000Z",
  status: "won",
  dedupeKey: "k1",
};

describe("templateWorkPackage", () => {
  it("produces a package with NO ai call that passes its own quality gate", () => {
    // Otherwise the fallback would swap one unusable artifact for another —
    // the same trap the bid-gate test guards against.
    const pkg = templateWorkPackage(GIG);
    expect(isUsableWorkPackage(pkg)).toBe(true);
    expect(pkg.generatedBy).toBe("template");
  });

  it("infers the stack from the posting's own words", () => {
    const pkg = templateWorkPackage(GIG);
    expect(pkg.techApproach).toMatch(/bot integration/i);
    expect(pkg.techApproach).toMatch(/web front end/i);
  });

  it("always asks the client something — thin postings are the norm", () => {
    expect(templateWorkPackage(GIG).questionsForClient.length).toBeGreaterThanOrEqual(3);
  });

  it("asks about budget differently depending on whether one was posted", () => {
    expect(templateWorkPackage(GIG).questionsForClient.join(" ")).toContain("$500");
    const noBudget = templateWorkPackage({ ...GIG, budget: undefined });
    expect(noBudget.questionsForClient.join(" ")).toMatch(/what budget range/i);
  });
});

describe("buildHandoffPrompt", () => {
  const base = {
    summary: "Build a Telegram ordering bot plus a small companion website.",
    deliverables: ["Telegram bot that accepts orders", "Simple website", "README"],
    questionsForClient: ["Which payment provider, if any?"],
    assumptions: ["Client supplies the Telegram bot token"],
    techApproach: "Python with the Telegram Bot API, plus a static front end.",
    estimateDays: 4,
  };

  it("carries everything Claude Code needs in one paste", () => {
    const p = buildHandoffPrompt(GIG, base);
    expect(p).toContain(GIG.title);
    expect(p).toContain(GIG.url);
    expect(p).toContain("$500");
    expect(p).toContain(GIG.snippet);
    for (const d of base.deliverables) expect(p).toContain(d);
    expect(p).toContain(base.techApproach);
    expect(p).toContain("Which payment provider, if any?");
    expect(p).toMatch(/definition of done/i);
    // Guards against the classic AI-delivery failure: stubs presented as done.
    expect(p).toMatch(/no placeholder or stub code/i);
  });

  it("tells the builder to decide and keep going rather than stall on an open question", () => {
    expect(buildHandoffPrompt(GIG, base)).toMatch(/do not stall/i);
  });

  it("is deterministic — what was reviewed is what gets pasted", () => {
    expect(buildHandoffPrompt(GIG, base)).toBe(buildHandoffPrompt(GIG, base));
  });

  it("omits empty sections instead of emitting dangling headers", () => {
    const p = buildHandoffPrompt(GIG, { ...base, questionsForClient: [], assumptions: [] });
    expect(p).not.toMatch(/open questions/i);
    expect(p).not.toMatch(/assumptions being made/i);
  });
});

describe("isUsableWorkPackage", () => {
  const good: WorkPackage = { ...templateWorkPackage(GIG) };

  it("accepts a sound package", () => {
    expect(isUsableWorkPackage(good)).toBe(true);
  });

  it("rejects the failure shapes that would look like real scope but aren't", () => {
    expect(isUsableWorkPackage(null)).toBe(false);
    expect(isUsableWorkPackage({ ...good, deliverables: [] })).toBe(false);
    expect(isUsableWorkPackage({ ...good, summary: "" })).toBe(false);
    // Truncated model fragment — the exact shape seen in the production bid bug.
    expect(isUsableWorkPackage({ ...good, summary: "Delivery Estimate):* Depending on your clients'" })).toBe(false);
    // Leaked markdown scaffolding.
    expect(isUsableWorkPackage({ ...good, summary: "**Scope:** build the bot and the site for the client as described." })).toBe(false);
    expect(isUsableWorkPackage({ ...good, estimateDays: 0 })).toBe(false);
    expect(isUsableWorkPackage({ ...good, estimateDays: 365 })).toBe(false);
    expect(isUsableWorkPackage({ ...good, techApproach: "  " })).toBe(false);
  });
});

describe("planWork op", () => {
  async function withRegistry(fn: (atlas: Atlas, gigFile: string) => Promise<void>, brain?: (p: unknown) => Promise<unknown>) {
    const dir = await mkdtemp(join(tmpdir(), "atlas-gig-wp-"));
    const gigFile = join(dir, "gigs.json");
    try {
      const registry = new GigRegistry(gigFile);
      await registry.addCandidates([{ source: "web", title: GIG.title, url: GIG.url, snippet: GIG.snippet, budget: GIG.budget }]);
      const atlas = new Atlas({ guardian: permissiveGuardian() });
      await atlas.use({
        manifest: { name: "fakebrain", version: "1", capabilities: ["brain"], permissions: [], role: "executor" },
        register(ctx) {
          ctx.provide("brain", async (p) => {
            if (!brain) throw new Error("brain unavailable (quota)");
            return brain(p);
          });
        },
      });
      await atlas.use(createGigFinderPlugin({ registry }));
      await fn(atlas, gigFile);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("falls back to the template package when the brain is unavailable", async () => {
    await withRegistry(async (atlas) => {
      const list = (await atlas.invoke("gigfinder", { op: "list" })) as Gig[];
      const g = (await atlas.invoke("gigfinder", { op: "planWork", id: list[0]!.id })) as Gig;
      expect(g.workPackage?.generatedBy).toBe("template");
      expect(isUsableWorkPackage(g.workPackage!)).toBe(true);
      expect(g.workPackage!.handoffPrompt).toContain("Telegram");
    });
  });

  it("falls back to the template when the brain returns gate-failing output", async () => {
    await withRegistry(
      async (atlas) => {
        const list = (await atlas.invoke("gigfinder", { op: "list" })) as Gig[];
        const g = (await atlas.invoke("gigfinder", { op: "planWork", id: list[0]!.id })) as Gig;
        expect(g.workPackage?.generatedBy).toBe("template");
      },
      async () => ({ text: JSON.stringify({ summary: "x", deliverables: [], techApproach: "", estimateDays: 0 }) }),
    );
  });

  it("uses the brain's package when it passes the gate, and builds its handoff prompt", async () => {
    await withRegistry(
      async (atlas) => {
        const list = (await atlas.invoke("gigfinder", { op: "list" })) as Gig[];
        const g = (await atlas.invoke("gigfinder", { op: "planWork", id: list[0]!.id })) as Gig;
        expect(g.workPackage?.generatedBy).toBe("brain");
        expect(g.workPackage!.summary).toMatch(/ordering bot/i);
        expect(g.workPackage!.handoffPrompt).toContain("Order-taking Telegram bot");
      },
      async () => ({
        text: JSON.stringify({
          summary: "Build a Telegram ordering bot and a small companion site for taking customer orders.",
          deliverables: ["Order-taking Telegram bot", "Companion website", "README"],
          questionsForClient: ["Which payment provider?"],
          assumptions: ["Client provides the bot token"],
          techApproach: "Python + Telegram Bot API, static front end.",
          estimateDays: 5,
        }),
      }),
    );
  });

  it("throws for an unknown gig id", async () => {
    await withRegistry(async (atlas) => {
      await expect(atlas.invoke("gigfinder", { op: "planWork", id: "nope" })).rejects.toThrow(/no gig/);
    });
  });
});

describe("isUsableBid", () => {
  // Every string below is a VERBATIM draftBid from the 28 approved gigs in
  // production on 2026-08-02. Synthetic samples would have made any threshold
  // look correct; these are what actually broke.
  const REAL_BROKEN = [
    "Call to Action/Wrap up):* Let me know",
    "I can develop and optimize the AI/ML models",
    "Approach.* I build using Python, robust APIs,",
    "I can quickly integrate the OpenAI API into your existing",
    "I will build a custom Python bot to monitor your selected Polym",
    "I can build a custom Android automation script designed to interact",
    "I will build your Telegram bot and username store website using Python",
  ];
  const REAL_GOOD =
    "I'll build a Python script that uses the Notion API to import a CSV file into your Notion database. " +
    "The script will be designed to handle various CSV formats and will include error handling for robustness. " +
    "I'll deliver a fully functional script within 3-5 business days.";

  it("rejects every bid that was actually broken in production", () => {
    for (const bid of REAL_BROKEN) {
      expect(isUsableBid(bid), `should reject: ${bid}`).toBe(false);
    }
  });

  it("accepts a real, complete bid", () => {
    expect(isUsableBid(REAL_GOOD)).toBe(true);
  });

  it("catches a truncation that is long enough to pass on length alone", () => {
    // Length is the weakest of the three signals — a generation can die after
    // 200 perfectly good characters.
    const truncated = REAL_GOOD.slice(0, 200);
    expect(truncated.length).toBeGreaterThan(150);
    expect(isUsableBid(truncated)).toBe(false);
  });

  it("rejects leaked scaffolding even in an otherwise long bid", () => {
    expect(isUsableBid(REAL_GOOD.replace("I'll build", "*Approach:* I'll build"))).toBe(false);
  });

  it("explains the specific problem rather than just failing", () => {
    expect(bidProblem("Call to Action/Wrap up):* Let me know")).toMatch(/cut off/);
    expect(bidProblem(REAL_GOOD.slice(0, 200))).toMatch(/mid-sentence/);
    expect(bidProblem(undefined)).toMatch(/no bid/);
    expect(bidProblem(REAL_GOOD)).toBeNull();
  });
});
