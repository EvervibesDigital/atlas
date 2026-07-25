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
import { createApprovalsPlugin } from "@atlas/approvals";
import { createSurplusPlugin } from "@atlas/surplus";
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
                ["case_number", "owner_name", "property_address", "county", "state", "estimated_surplus"],
                ["CASE-9", "Jane Doe", "123 Main St", "Marion", "IN", "$18,000"],
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
});
