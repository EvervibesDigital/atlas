import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { Atlas, ConfigVault } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { createMemoryPlugin, InMemoryStore } from "@atlas/memory";
import { createBrainPlugin, StubAdapter } from "@atlas/brain";
import { createSearchPlugin, type FetchLike } from "@atlas/search";
import { createKdpPlugin } from "@atlas/kdp";
import { createGigFinderPlugin } from "@atlas/gigfinder";
import { createApprovalsPlugin, ApprovalGateway } from "@atlas/approvals";
import { createSurplusPlugin } from "@atlas/surplus";
import { createOutreachPlugin } from "@atlas/outreach";
import { createLeadScanPlugin } from "@atlas/leadscan";
import { createLearningPlugin, MetricsTracker } from "@atlas/learning";
import { createWholesalePlugin } from "@atlas/wholesale";
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

  describe("surplus source", () => {
    // A real RSA key so the Sheets client's actual JWT-signing code path runs.
    const TEST_PRIVATE_KEY_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();

    // Combined fake for surplus's shared fetcher: routes Twin's REST calls
    // and Google's OAuth token + Sheets values.get calls by hostname/path.
    function fakeSurplusFetch(sawRunBody: { value: string }): typeof fetch {
      return (async (url: string, init?: RequestInit) => {
        const u = new URL(url);
        if (u.hostname === "oauth2.googleapis.com") {
          return { ok: true, status: 200, json: async () => ({ access_token: "t" }) } as Response;
        }
        if (u.hostname === "sheets.googleapis.com") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              values: [
                ["case number", "owner name", "property address", "county", "state", "estimated surplus", "email sent"],
                ["CASE-9", "Jane Doe", "123 Main St", "Marion", "IN", "$18,000", "No"],
              ],
            }),
          } as Response;
        }
        if (u.pathname === "/v1/agents/019cbedd-7f20-70c2-a3d3-f75a79d7f258/runs") {
          sawRunBody.value = String(init?.body);
          return { ok: true, status: 200, json: async () => ({ run_id: "run-outreach-1" }) } as Response;
        }
        throw new Error(`no fake handler for ${u.hostname}${u.pathname}`);
      }) as typeof fetch;
    }

    async function buildSurplusBriefAtlas(f: typeof fetch) {
      const atlas = new Atlas({
        guardian: new Guardian(),
        config: new ConfigVault({ TWIN_API_KEY: "twin_abc", GOOGLE_SHEETS_CLIENT_EMAIL: "svc@x.iam.gserviceaccount.com", GOOGLE_SHEETS_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM }),
      });
      await atlas.use(createMemoryPlugin({ store: new InMemoryStore() }));
      await atlas.use(createSurplusPlugin({ fetcher: f }));
      await atlas.use(createBriefPlugin());
      return atlas;
    }

    it("surfaces a lead over $5,000 as one Brief item, priced and addressed", async () => {
      const sawRunBody = { value: "" };
      const atlas = await buildSurplusBriefAtlas(fakeSurplusFetch(sawRunBody));
      await atlas.use({
        manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:brief"], role: "executor" },
        async register(ctx) {
          const r = (await ctx.call("brief", { op: "today" })) as { items: BriefItem[] };
          const item = r.items.find((i) => i.source === "surplus")!;
          expect(item.id).toBe("CASE-9");
          expect(item.title).toBe("Jane Doe — 123 Main St");
          expect(item.detail).toContain("$18,000");
          expect(item.detail).toContain("Approving triggers real outreach");
        },
      });
    });

    it("act(approve) triggers the Lead Outreach Agent with a message naming the specific owner and case", async () => {
      const sawRunBody = { value: "" };
      const atlas = await buildSurplusBriefAtlas(fakeSurplusFetch(sawRunBody));
      await atlas.use({
        manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:brief"], role: "executor" },
        async register(ctx) {
          const res = (await ctx.call("brief", { op: "act", source: "surplus", id: "CASE-9", action: "approve" })) as { run_id?: string };
          expect(res.run_id).toBe("run-outreach-1");
        },
      });
      const body = JSON.parse(sawRunBody.value);
      expect(body.user_message).toContain("Jane Doe");
      expect(body.user_message).toContain("CASE-9");
      expect(body.user_message).toContain("$18,000");
    });

    it("act(reject) on a surplus lead is a no-op — never calls Twin", async () => {
      const sawRunBody = { value: "" };
      const atlas = await buildSurplusBriefAtlas(fakeSurplusFetch(sawRunBody));
      await atlas.use({
        manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:brief"], role: "executor" },
        async register(ctx) {
          const res = (await ctx.call("brief", { op: "act", source: "surplus", id: "CASE-9", action: "reject" })) as { skipped?: string };
          expect(res.skipped).toBe("CASE-9");
        },
      });
      expect(sawRunBody.value).toBe("");
    });
  });

  describe("leadscan source", () => {
    function fakeLeadscanFetch(sawOutreachBody: { value: string }): typeof fetch {
      return (async (url: string, init?: RequestInit) => {
        const u = new URL(url);
        if (u.hostname === "generativelanguage.googleapis.com") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              candidates: [{ content: { parts: [{ text: '[{"businessName":"Joe\'s Plumbing","website":"https://joesplumbing.example","phone":"555-1234","email":"joe@example.com"}]' }] } }],
            }),
          } as Response;
        }
        if (u.hostname === "joesplumbing.example") {
          return { ok: true, status: 200, text: async () => `<html><head></head><body><img src="x.png"></body></html>` } as Response;
        }
        if (u.hostname === "n8n.evervibes.org") {
          sawOutreachBody.value = String(init?.body);
          return { ok: true, status: 200, json: async () => ({ received: true }) } as Response;
        }
        throw new Error(`no fake handler for ${u.hostname}`);
      }) as typeof fetch;
    }

    async function buildLeadscanBriefAtlas(f: typeof fetch, leadFile: string) {
      const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({ GEMINI_API_KEY: "test-gemini-key", N8N_API_KEY: "test-n8n-key" }) });
      await atlas.use(createMemoryPlugin({ store: new InMemoryStore() }));
      await atlas.use(createOutreachPlugin({ fetcher: f }));
      await atlas.use(createLeadScanPlugin({ leadFile, fetcher: f }));
      await atlas.use(createBriefPlugin());
      return atlas;
    }

    it("surfaces a newly-found, scanned lead as one Brief item with its score", async () => {
      const dir = await mkdtemp(join(tmpdir(), "atlas-brief-leadscan-"));
      const leadFile = join(dir, "leads.json");
      try {
        const sawOutreachBody = { value: "" };
        const atlas = await buildLeadscanBriefAtlas(fakeLeadscanFetch(sawOutreachBody), leadFile);
        await atlas.use({
          manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:leadscan", "call:brief"], role: "executor" },
          async register(ctx) {
            await ctx.call("leadscan", { op: "findLeads", niche: "plumbing", city: "Columbus, OH" });
            const r = (await ctx.call("brief", { op: "today" })) as { items: BriefItem[] };
            const item = r.items.find((i) => i.source === "leadscan")!;
            expect(item.title).toBe("Joe's Plumbing — https://joesplumbing.example");
            expect(item.detail).toMatch(/Score \d+\/100/);
            expect(item.detail).toContain("Approving emails this business");
          },
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("act(approve) sends outreach and removes the lead from the next brief", async () => {
      const dir = await mkdtemp(join(tmpdir(), "atlas-brief-leadscan-"));
      const leadFile = join(dir, "leads.json");
      try {
        const sawOutreachBody = { value: "" };
        const atlas = await buildLeadscanBriefAtlas(fakeLeadscanFetch(sawOutreachBody), leadFile);
        await atlas.use({
          manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:leadscan", "call:brief"], role: "executor" },
          async register(ctx) {
            await ctx.call("leadscan", { op: "findLeads", niche: "plumbing", city: "Columbus, OH" });
            const before = (await ctx.call("brief", { op: "today" })) as { items: BriefItem[] };
            const lead = before.items.find((i) => i.source === "leadscan")!;

            await ctx.call("brief", { op: "act", source: "leadscan", id: lead.id, action: "approve" });
            expect(JSON.parse(sawOutreachBody.value).name).toBe("Joe's Plumbing");

            const after = (await ctx.call("brief", { op: "today" })) as { items: BriefItem[] };
            expect(after.items.find((i) => i.source === "leadscan")).toBeUndefined();
          },
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("tags a lead email as 'bulk' tier, and actBulk sends the whole batch in one call", async () => {
      const dir = await mkdtemp(join(tmpdir(), "atlas-brief-leadscan-"));
      const leadFile = join(dir, "leads.json");
      try {
        const sawOutreachBody = { value: "" };
        const atlas = await buildLeadscanBriefAtlas(fakeLeadscanFetch(sawOutreachBody), leadFile);
        await atlas.use({
          manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:leadscan", "call:brief"], role: "executor" },
          async register(ctx) {
            await ctx.call("leadscan", { op: "findLeads", niche: "plumbing", city: "Columbus, OH" });
            const before = (await ctx.call("brief", { op: "today" })) as { items: BriefItem[] };
            expect(before.items.find((i) => i.source === "leadscan")!.tier).toBe("bulk");

            const res = (await ctx.call("brief", { op: "actBulk", action: "approve" })) as { count: number };
            expect(res.count).toBe(1);
            expect(JSON.parse(sawOutreachBody.value).name).toBe("Joe's Plumbing");

            const after = (await ctx.call("brief", { op: "today" })) as { items: BriefItem[] };
            expect(after.items.find((i) => i.source === "leadscan")).toBeUndefined();
          },
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("learning source (ATLAS's own self-improvement proposals)", () => {
    async function buildLearningBriefAtlas() {
      const atlas = new Atlas({ guardian: new Guardian() });
      await atlas.use(createMemoryPlugin({ store: new InMemoryStore() }));
      await atlas.use(createLearningPlugin({ metrics: new MetricsTracker() }));
      await atlas.use(createBriefPlugin());
      return atlas;
    }

    it("surfaces an underperforming category as one Brief item, no manual tab visit needed", async () => {
      const atlas = await buildLearningBriefAtlas();
      await atlas.use({
        manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:learning", "call:brief"], role: "executor" },
        async register(ctx) {
          for (let i = 0; i < 4; i++) await ctx.call("learning", { op: "reflect", event: "cold-dm", outcome: "failure", category: "outreach" });
          const r = (await ctx.call("brief", { op: "today" })) as { items: BriefItem[] };
          const item = r.items.find((i) => i.source === "learning")!;
          expect(item.title).toBe("ATLAS proposal: outreach");
          expect(item.detail).toMatch(/succeeding only 0% of the time/);
          expect(item.id).toBe("outreach");
        },
      });
    });

    it("act(approve) adopts the proposal (writes a standing directive) and removes it from the next brief", async () => {
      const atlas = await buildLearningBriefAtlas();
      await atlas.use({
        manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:learning", "call:memory", "call:brief"], role: "executor" },
        async register(ctx) {
          for (let i = 0; i < 4; i++) await ctx.call("learning", { op: "reflect", event: "cold-dm", outcome: "failure", category: "outreach" });

          await ctx.call("brief", { op: "act", source: "learning", id: "outreach", action: "approve" });

          // "recent" by kind, not "search" — the default stub embedder in
          // tests doesn't do real semantic filtering.
          const directives = (await ctx.call("memory", { op: "recent", kind: "directive" })) as unknown[];
          expect(directives.length).toBe(1);

          const after = (await ctx.call("brief", { op: "today" })) as { items: BriefItem[] };
          expect(after.items.find((i) => i.source === "learning")).toBeUndefined();
        },
      });
    });

    it("act(reject) dismisses the proposal without writing to memory, and it stays gone", async () => {
      const atlas = await buildLearningBriefAtlas();
      await atlas.use({
        manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:learning", "call:memory", "call:brief"], role: "executor" },
        async register(ctx) {
          for (let i = 0; i < 4; i++) await ctx.call("learning", { op: "reflect", event: "cold-dm", outcome: "failure", category: "outreach" });

          await ctx.call("brief", { op: "act", source: "learning", id: "outreach", action: "reject" });

          const directives = (await ctx.call("memory", { op: "recent", kind: "directive" })) as unknown[];
          expect(directives.length).toBe(0);

          const after = (await ctx.call("brief", { op: "today" })) as { items: BriefItem[] };
          expect(after.items.find((i) => i.source === "learning")).toBeUndefined();
        },
      });
    });

    it("tags a learning proposal as 'auto' tier, and autopilot adopts it unattended (no manual approve)", async () => {
      const atlas = await buildLearningBriefAtlas();
      await atlas.use({
        manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:learning", "call:memory", "call:brief"], role: "executor" },
        async register(ctx) {
          for (let i = 0; i < 4; i++) await ctx.call("learning", { op: "reflect", event: "cold-dm", outcome: "failure", category: "outreach" });

          const before = (await ctx.call("brief", { op: "today" })) as { items: BriefItem[] };
          expect(before.items.find((i) => i.source === "learning")!.tier).toBe("auto");

          // Autopilot — no per-item approve call. It should adopt the proposal.
          const res = (await ctx.call("brief", { op: "autopilot" })) as { count: number };
          expect(res.count).toBe(1);

          const directives = (await ctx.call("memory", { op: "recent", kind: "directive" })) as unknown[];
          expect(directives.length).toBe(1); // proposal was adopted into a standing directive

          const after = (await ctx.call("brief", { op: "today" })) as { items: BriefItem[] };
          expect(after.items.find((i) => i.source === "learning")).toBeUndefined();
        },
      });
    });

    it("autopilot leaves 'ask'/'bulk' items untouched — only ever acts on 'auto'", async () => {
      // A learning proposal (auto) alongside a generic approvals item (ask):
      // autopilot must adopt the proposal but never touch the approval.
      const atlas = new Atlas({ guardian: new Guardian() });
      await atlas.use(createMemoryPlugin({ store: new InMemoryStore() }));
      await atlas.use(createApprovalsPlugin({ gateway: new ApprovalGateway() }));
      await atlas.use(createLearningPlugin({ metrics: new MetricsTracker() }));
      await atlas.use(createBriefPlugin());
      await atlas.use({
        manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:learning", "call:approvals", "call:brief"], role: "executor" },
        async register(ctx) {
          for (let i = 0; i < 4; i++) await ctx.call("learning", { op: "reflect", event: "cold-dm", outcome: "failure", category: "outreach" });
          await ctx.call("approvals", { op: "request", action: "Spend $500 on ads", risk: 3 });

          await ctx.call("brief", { op: "autopilot" });

          const after = (await ctx.call("brief", { op: "today" })) as { items: BriefItem[] };
          // The learning proposal is gone (auto-adopted); the risky approval remains.
          expect(after.items.find((i) => i.source === "learning")).toBeUndefined();
          const stillPending = after.items.find((i) => i.source === "approvals");
          expect(stillPending).toBeTruthy();
          expect(stillPending!.tier).toBe("ask");
        },
      });
    });
  });

  describe("wholesale source", () => {
    async function buildWholesaleBriefAtlas(actions: unknown[]) {
      const f: FetchLike = (async (url: string) => {
        expect(String(url)).toContain("/api/wholesale/pending-actions/list");
        return { ok: true, status: 200, json: async () => ({ actions }) };
      }) as unknown as FetchLike;
      const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({ KDP_CRON_SECRET: "test-secret" }) });
      await atlas.use(createWholesalePlugin({ fetcher: f as unknown as typeof fetch }));
      await atlas.use(createBriefPlugin());
      return atlas;
    }

    it("labels seller-kind outreach_email distinctly from investor outreach, and batches both as 'bulk'", async () => {
      const atlas = await buildWholesaleBriefAtlas([
        { id: "a1", action_type: "outreach_email", roi_score: 0, target_count: 1, target_summary: "Jane Doe — 123 Main St, Columbus", reason: "Cold outreach, touch 1", payload: { kind: "seller" }, created_at: "2026-07-26T00:00:00Z" },
        { id: "a2", action_type: "outreach_email", roi_score: 0, target_count: 1, target_summary: "Some Investor", reason: "Investor pitch", payload: { kind: "investor" }, created_at: "2026-07-26T00:00:00Z" },
        { id: "a3", action_type: "bland_call", roi_score: 12000, target_count: 1, target_summary: "Mike (bird dog)", reason: "$12K spread", created_at: "2026-07-26T00:00:00Z" },
      ]);
      await atlas.use({
        manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:brief"], role: "executor" },
        async register(ctx) {
          const r = (await ctx.call("brief", { op: "today" })) as { items: BriefItem[] };
          const seller = r.items.find((i) => i.id === "a1")!;
          const investor = r.items.find((i) => i.id === "a2")!;
          const call = r.items.find((i) => i.id === "a3")!;

          expect(seller.title).toContain("Seller outreach email");
          expect(seller.title).not.toContain("Investor");
          expect(seller.tier).toBe("bulk");

          expect(investor.title).toContain("Investor outreach email");
          expect(investor.tier).toBe("bulk");

          // A phone call still stays individual, unaffected by this change.
          expect(call.tier).toBe("ask");
        },
      });
    });
  });

  describe("social source", () => {
    it("groups ready content by creator into one bulk item, not one per post", async () => {
      const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({}) });
      await atlas.use(createBriefPlugin());
      await atlas.use({
        manifest: { name: "social", version: "1", capabilities: ["social"], permissions: [], role: "executor" },
        register(ctx) {
          ctx.provide("social", async (payload: unknown) => {
            const cmd = payload as { op: string };
            if (cmd.op === "listAccounts") return { accounts: [{ id: "acc1", personaLabel: "Aria Vance", platform: "instagram" }] };
            throw new Error("unexpected social op in test: " + cmd.op);
          });
        },
      });
      await atlas.use({
        manifest: { name: "mediaFactory", version: "1", capabilities: ["mediaFactory"], permissions: [], role: "executor" },
        register(ctx) {
          ctx.provide("mediaFactory", async (payload: unknown) => {
            const cmd = payload as { op: string };
            if (cmd.op === "listCreators") return [{ id: "creator1", name: "Aria Vance" }];
            if (cmd.op === "listContent") {
              return [
                { id: "item1", creator_id: "creator1", platform: "instagram", status: "review", title: "t1", caption: "cap1", assets: { image_path: "/img1.jpg" } },
                { id: "item2", creator_id: "creator1", platform: "instagram", status: "review", title: "t2", caption: "cap2", assets: { image_path: "/img2.jpg" } },
                { id: "item3", creator_id: "creator1", platform: "instagram", status: "planned", title: "t3" }, // not ready yet, excluded
              ];
            }
            throw new Error("unexpected mediaFactory op in test: " + cmd.op);
          });
        },
      });

      const brief = (await atlas.invoke("brief", { op: "today" })) as { items: Array<{ source: string; title: string; tier: string; detail?: string }> };
      const socialItems = brief.items.filter((i) => i.source === "social");
      expect(socialItems).toHaveLength(1); // one item for the whole creator, not one per post
      expect(socialItems[0]!.title).toContain("Aria Vance");
      expect(socialItems[0]!.title).toContain("2"); // 2 ready posts
      expect(socialItems[0]!.tier).toBe("bulk");
    });
  });
});
