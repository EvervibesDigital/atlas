import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Atlas, ConfigVault } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { createMemoryPlugin, InMemoryStore } from "@atlas/memory";
import { createOutreachPlugin } from "@atlas/outreach";
import { createLeadScanPlugin } from "../src/plugin";
import type { LeadScanCommand } from "../src/types";

// Routes by hostname so one fake fetcher can stand in for Gemini, the
// scanned lead's own website, and n8n's webhook — a real end-to-end flow.
function combinedFetch(): typeof fetch {
  return (async (url: string) => {
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
      return { ok: true, status: 200, json: async () => ({ received: true }) } as Response;
    }
    throw new Error(`no fake handler for ${u.hostname}`);
  }) as typeof fetch;
}

async function buildTestAtlas(leadFile: string) {
  const f = combinedFetch();
  const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({ GEMINI_API_KEY: "test-gemini-key", N8N_API_KEY: "test-n8n-key" }) });
  await atlas.use(createMemoryPlugin({ store: new InMemoryStore() }));
  await atlas.use(createOutreachPlugin({ fetcher: f }));
  await atlas.use(createLeadScanPlugin({ leadFile, fetcher: f }));
  return atlas;
}

describe("leadscan plugin — full flow", () => {
  it("finds leads, scans each one immediately, lists them as new, approves one (sends via outreach), rejects nothing left unresolved", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-leadscan-"));
    const leadFile = join(dir, "leads.json");
    try {
      const atlas = await buildTestAtlas(leadFile);
      await atlas.use({
        manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:leadscan", "call:memory"], role: "executor" },
        async register(ctx) {
          const found = (await ctx.call("leadscan", { op: "findLeads", niche: "plumbing", city: "Columbus, OH" } satisfies LeadScanCommand)) as { found: number; leads: Array<{ id: string; businessName: string; status: string; scan?: { overallScore: number } }> };
          expect(found.found).toBe(1);
          expect(found.leads[0]!.businessName).toBe("Joe's Plumbing");
          expect(found.leads[0]!.status).toBe("new");
          expect(found.leads[0]!.scan?.overallScore).toBeLessThan(100); // the fake site is missing alt text, privacy, viewport

          const listed = (await ctx.call("leadscan", { op: "list", status: "new" } satisfies LeadScanCommand)) as Array<{ id: string }>;
          expect(listed).toHaveLength(1);

          const approved = (await ctx.call("leadscan", { op: "approve", id: listed[0]!.id } satisfies LeadScanCommand)) as { status: string; outreach: { received: boolean } };
          expect(approved.status).toBe("contacted");
          expect(approved.outreach.received).toBe(true);

          const stillNew = (await ctx.call("leadscan", { op: "list", status: "new" } satisfies LeadScanCommand)) as unknown[];
          expect(stillNew).toHaveLength(0);
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("re-running findLeads for the same niche/city does not duplicate an already-found lead", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-leadscan-"));
    const leadFile = join(dir, "leads.json");
    try {
      const atlas = await buildTestAtlas(leadFile);
      await atlas.use({
        manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:leadscan"], role: "executor" },
        async register(ctx) {
          const first = (await ctx.call("leadscan", { op: "findLeads", niche: "plumbing", city: "Columbus, OH" } satisfies LeadScanCommand)) as { found: number };
          const second = (await ctx.call("leadscan", { op: "findLeads", niche: "plumbing", city: "Columbus, OH" } satisfies LeadScanCommand)) as { found: number };
          expect(first.found).toBe(1);
          expect(second.found).toBe(0);
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reject marks a lead rejected without ever calling outreach", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-leadscan-"));
    const leadFile = join(dir, "leads.json");
    try {
      const atlas = await buildTestAtlas(leadFile);
      await atlas.use({
        manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:leadscan"], role: "executor" },
        async register(ctx) {
          const found = (await ctx.call("leadscan", { op: "findLeads", niche: "plumbing", city: "Columbus, OH" } satisfies LeadScanCommand)) as { leads: Array<{ id: string }> };
          const rejected = (await ctx.call("leadscan", { op: "reject", id: found.leads[0]!.id } satisfies LeadScanCommand)) as { status: string };
          expect(rejected.status).toBe("rejected");
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws a clear error when GEMINI_API_KEY is missing", async () => {
    const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({}) });
    await atlas.use(createLeadScanPlugin());
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:leadscan"], role: "executor" },
      async register(ctx) {
        await expect(ctx.call("leadscan", { op: "findLeads", niche: "plumbing", city: "Columbus, OH" } satisfies LeadScanCommand)).rejects.toThrow(/GEMINI_API_KEY/);
      },
    });
  });
});
