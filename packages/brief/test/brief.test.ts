import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Atlas, ConfigVault } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { createMemoryPlugin, InMemoryStore } from "@atlas/memory";
import { createBrainPlugin, StubAdapter } from "@atlas/brain";
import { createSearchPlugin, type FetchLike } from "@atlas/search";
import { createKdpPlugin } from "@atlas/kdp";
import { createGigFinderPlugin } from "@atlas/gigfinder";
import { createApprovalsPlugin } from "@atlas/approvals";
import { createBriefPlugin } from "../src/plugin";
import type { BriefItem } from "../src/types";

// Fakes fetch for kdp's HTTP-bridge calls, routed by pathname — same seam
// @atlas/kdp's own tests use.
function fakeKdpFetch(): typeof fetch {
  return (async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/api/kdp/status") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          books: [{ id: "book-1", niche: "journals", title: "2027 Gratitude Journal", status: "generated", created_at: "2026-07-20T05:00:00Z" }],
        }),
      } as Response;
    }
    throw new Error(`no fake handler for ${path}`);
  }) as typeof fetch;
}

function fakeTavily(): FetchLike {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      results: [{ title: "Automate CSV cleanup with Python, $75", url: "https://example.com/job1", content: "Need a python script that dedupes CSV exports." }],
    }),
  })) as unknown as FetchLike;
}

async function buildTestAtlas(gigFile: string, approvalsFile: string) {
  const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({ KDP_CRON_SECRET: "s3cret", TAVILY_API_KEY: "test-key" }) });
  await atlas.use(createMemoryPlugin({ store: new InMemoryStore() }));
  await atlas.use(createBrainPlugin({ adapters: [new StubAdapter()] }));
  await atlas.use(createSearchPlugin({ fetcher: fakeTavily() }));
  await atlas.use(createKdpPlugin({ fetcher: fakeKdpFetch() }));
  await atlas.use(createGigFinderPlugin({ gigFile }));
  await atlas.use(createApprovalsPlugin({ file: approvalsFile }));
  await atlas.use(createBriefPlugin());
  return atlas;
}

describe("brief plugin — the Unified Morning Brief", () => {
  it("aggregates pending items from kdp, gigfinder, and approvals into one sorted list", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-brief-"));
    const gigFile = join(dir, "gigs.json");
    const approvalsFile = join(dir, "approvals.json");
    try {
      const atlas = await buildTestAtlas(gigFile, approvalsFile);
      await atlas.use({
        manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:gigfinder", "call:approvals", "call:brief"], role: "executor" },
        async register(ctx) {
          // Seed a gigfinder "new" item and an approvals-gateway pending item;
          // kdp's fake fetch already returns one "generated" book.
          await ctx.call("gigfinder", { op: "search" });
          await ctx.call("approvals", { op: "request", action: "Post video to TikTok", detail: "Reel about Q3 trends", risk: 2 });

          const r = (await ctx.call("brief", { op: "today" })) as { items: BriefItem[]; count: number };
          expect(r.count).toBe(3);

          const bySource = Object.fromEntries(r.items.map((i) => [i.source, i]));
          expect(bySource.kdp!.title).toBe("2027 Gratitude Journal");
          expect(bySource.gigfinder!.title).toMatch(/CSV/i);
          expect(bySource.approvals!.title).toBe("Post video to TikTok");

          // Highest risk (the approvals item, risk 2) should sort first.
          expect(r.items[0]!.source).toBe("approvals");
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("act(approve) on a gigfinder item drafts a pitch and removes it from the next brief", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-brief-"));
    const gigFile = join(dir, "gigs.json");
    const approvalsFile = join(dir, "approvals.json");
    try {
      const atlas = await buildTestAtlas(gigFile, approvalsFile);
      await atlas.use({
        manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:gigfinder", "call:brief"], role: "executor" },
        async register(ctx) {
          await ctx.call("gigfinder", { op: "search" });
          const before = (await ctx.call("brief", { op: "today" })) as { items: BriefItem[] };
          const gig = before.items.find((i) => i.source === "gigfinder")!;

          const acted = (await ctx.call("brief", { op: "act", source: "gigfinder", id: gig.id, action: "approve" })) as { status: string; draftBid?: string };
          expect(acted.status).toBe("approved");
          expect(acted.draftBid).toBeTruthy();

          const after = (await ctx.call("brief", { op: "today" })) as { items: BriefItem[] };
          expect(after.items.find((i) => i.source === "gigfinder")).toBeUndefined();
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("act(reject) on an approvals item resolves it via the approvals gateway", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-brief-"));
    const gigFile = join(dir, "gigs.json");
    const approvalsFile = join(dir, "approvals.json");
    try {
      const atlas = await buildTestAtlas(gigFile, approvalsFile);
      await atlas.use({
        manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:approvals", "call:brief"], role: "executor" },
        async register(ctx) {
          const req = (await ctx.call("approvals", { op: "request", action: "Send outreach email", risk: 1 })) as { id: string };
          const acted = (await ctx.call("brief", { op: "act", source: "approvals", id: req.id, action: "reject" })) as { status: string };
          expect(acted.status).toBe("rejected");

          const after = (await ctx.call("brief", { op: "today" })) as { items: BriefItem[] };
          expect(after.items.find((i) => i.source === "approvals")).toBeUndefined();
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips a source that errors instead of failing the whole brief", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-brief-"));
    const gigFile = join(dir, "gigs.json");
    const approvalsFile = join(dir, "approvals.json");
    try {
      // No KDP_CRON_SECRET set -> kdp.status throws; brief should still return the other sources.
      const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({ TAVILY_API_KEY: "test-key" }) });
      await atlas.use(createMemoryPlugin({ store: new InMemoryStore() }));
      await atlas.use(createBrainPlugin({ adapters: [new StubAdapter()] }));
      await atlas.use(createSearchPlugin({ fetcher: fakeTavily() }));
      await atlas.use(createKdpPlugin({ fetcher: fakeKdpFetch() }));
      await atlas.use(createGigFinderPlugin({ gigFile }));
      await atlas.use(createApprovalsPlugin({ file: approvalsFile }));
      await atlas.use(createBriefPlugin());
      await atlas.use({
        manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:gigfinder", "call:brief"], role: "executor" },
        async register(ctx) {
          await ctx.call("gigfinder", { op: "search" });
          const r = (await ctx.call("brief", { op: "today" })) as { items: BriefItem[]; count: number };
          expect(r.count).toBe(1);
          expect(r.items[0]!.source).toBe("gigfinder");
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
