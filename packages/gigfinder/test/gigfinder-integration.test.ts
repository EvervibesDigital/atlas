import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Atlas, ConfigVault } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { createMemoryPlugin, InMemoryStore } from "@atlas/memory";
import { createBrainPlugin } from "@atlas/brain";
import { StubAdapter } from "@atlas/brain";
import { createSearchPlugin, type FetchLike } from "@atlas/search";
import { createGigFinderPlugin } from "../src/plugin";
import type { Gig } from "../src/types";

// Full command-flow integration test — the existing gigfinder.test.ts only
// covers the pure helper functions (matching/dedup/registry). This exercises
// the actual plugin wiring: search -> dedupe -> queue -> approve -> draft a
// real pitch via the brain -> markSubmitted -> stats. No live API keys —
// the search plugin's fetcher is faked (same seam @atlas/kdp's tests use),
// and the brain uses StubAdapter, same as every other offline ATLAS test.

function fakeTavily(): FetchLike {
  return (async (_url: string, _init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => ({
      results: [
        { title: "Need Python script to automate CSV cleanup, $75", url: "https://example.com/job1", content: "Looking for someone to write a python script that dedupes and reformats CSV exports weekly." },
        { title: "Freelance graphic designer for logo — no code", url: "https://example.com/job2", content: "Need a hand-drawn logo, no AI/automation involved, must be a human illustrator." },
      ],
    }),
  })) as unknown as FetchLike;
}

async function buildTestAtlas(gigFile: string) {
  const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({ TAVILY_API_KEY: "test-tavily-key" }) });
  await atlas.use(createMemoryPlugin({ store: new InMemoryStore() }));
  await atlas.use(createBrainPlugin({ adapters: [new StubAdapter()] }));
  await atlas.use(createSearchPlugin({ fetcher: fakeTavily() }));
  await atlas.use(createGigFinderPlugin({ gigFile }));
  return atlas;
}

describe("gigfinder plugin — full command flow", () => {
  it("searches, dedupes to AI-doable candidates only, then approves/drafts/submits/stats end-to-end", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-gigfinder-"));
    const gigFile = join(dir, "gigs.json");
    try {
      const atlas = await buildTestAtlas(gigFile);
      let found: { found: number; jobs: Gig[] } | undefined;

      await atlas.use({
        manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:gigfinder", "call:memory"], role: "executor" },
        async register(ctx) {
          // 1. Search — the non-AI-doable logo gig must be filtered out by isAiDoable.
          found = (await ctx.call("gigfinder", { op: "search" })) as { found: number; jobs: Gig[] };
          expect(found.found).toBe(1);
          expect(found.jobs[0]!.title).toMatch(/CSV/i);

          // 2. Re-searching the exact same results must not create duplicates.
          const second = (await ctx.call("gigfinder", { op: "search" })) as { found: number };
          expect(second.found).toBe(0);

          // 3. Listing shows the queued gig with status "new".
          const listed = (await ctx.call("gigfinder", { op: "list" })) as Gig[];
          expect(listed).toHaveLength(1);
          expect(listed[0]!.status).toBe("new");

          // 4. Approve — this drafts a real pitch through the brain (StubAdapter).
          const gigId = listed[0]!.id;
          const approved = (await ctx.call("gigfinder", { op: "approve", id: gigId })) as Gig;
          expect(approved.status).toBe("approved");
          expect(approved.draftBid).toBeTruthy();
          expect(approved.draftBid!.length).toBeGreaterThan(0);

          // 5. Mark submitted (this is the step Mat does by hand after pasting the draft).
          const submitted = (await ctx.call("gigfinder", { op: "markSubmitted", id: gigId })) as Gig;
          expect(submitted.status).toBe("submitted");
          expect(submitted.submittedAt).toBeTruthy();

          // 6. Stats reflect the full lifecycle.
          const stats = (await ctx.call("gigfinder", { op: "stats" })) as { submitted: number; new: number };
          expect(stats.submitted).toBe(1);
          expect(stats.new).toBe(0);
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("files a memory note when new gigs are found", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-gigfinder-"));
    const gigFile = join(dir, "gigs.json");
    try {
      const atlas = await buildTestAtlas(gigFile);
      await atlas.use({
        manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:gigfinder", "call:memory"], role: "executor" },
        async register(ctx) {
          await ctx.call("gigfinder", { op: "search" });
          const notes = (await ctx.call("memory", { op: "search", query: "Gig Finder found", options: { limit: 5 } })) as unknown[];
          expect(notes.length).toBeGreaterThan(0);
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
