import { describe, it, expect } from "vitest";
import { Atlas, ConfigVault, type Plugin } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { createMemoryPlugin, InMemoryStore } from "@atlas/memory";
import { createCfoPlugin } from "../src/plugin";
import type { FetchLike } from "../src/revenue";

const SUMMARY_BODY = {
  as_of: "2026-07-26T00:00:00.000Z",
  mrr: 250,
  one_time_this_month: 39,
  breakdown: { saas_mrr: 150, saas_active_subscribers: 3, wholesale_investor_mrr: 100, wholesale_paying_investors: 1, module_purchases_this_month: 0, deal_unlocks_this_month: 39 },
};

function fakeRevenueFetch(): FetchLike {
  return (async () => ({ ok: true, status: 200, json: async () => SUMMARY_BODY })) as unknown as FetchLike;
}

async function buildAtlas(f: FetchLike) {
  const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({ KDP_CRON_SECRET: "test-secret" }) });
  await atlas.use(createMemoryPlugin({ store: new InMemoryStore() }));
  await atlas.use(createCfoPlugin({ fetcher: f }));
  return atlas;
}

describe("cfo plugin wired through the kernel", () => {
  it("pullReal returns the live revenue summary from the bridge", async () => {
    const atlas = await buildAtlas(fakeRevenueFetch());
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:cfo"], role: "executor" },
      async register(ctx) {
        const real = (await ctx.call("cfo", { op: "pullReal" })) as { mrr: number };
        expect(real.mrr).toBe(250);
      },
    } satisfies Plugin);
  });

  it("forecast auto-fills monthlyRevenue from real MRR when omitted", async () => {
    const atlas = await buildAtlas(fakeRevenueFetch());
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:cfo", "call:memory"], role: "executor" },
      async register(ctx) {
        const result = (await ctx.call("cfo", { op: "forecast", inputs: { cashOnHand: 10000, monthlyExpenses: 100 } })) as {
          monthlyRevenue: number; realRevenueUsed: boolean; netMonthly: number; verdict: string;
        };
        expect(result.realRevenueUsed).toBe(true);
        expect(result.monthlyRevenue).toBe(250);
        expect(result.netMonthly).toBe(150); // 250 - 100
        expect(result.verdict).toBe("healthy");
      },
    } satisfies Plugin);
  });

  it("forecast uses an explicitly-supplied monthlyRevenue instead of pulling real data", async () => {
    let fetchCalled = false;
    const f: FetchLike = (async () => { fetchCalled = true; return { ok: true, status: 200, json: async () => SUMMARY_BODY } as Response; }) as unknown as FetchLike;
    const atlas = await buildAtlas(f);
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:cfo", "call:memory"], role: "executor" },
      async register(ctx) {
        const result = (await ctx.call("cfo", { op: "forecast", inputs: { cashOnHand: 1000, monthlyRevenue: 9999, monthlyExpenses: 500 } })) as { monthlyRevenue: number; realRevenueUsed: boolean };
        expect(result.monthlyRevenue).toBe(9999);
        expect(result.realRevenueUsed).toBe(false);
        expect(fetchCalled).toBe(false); // never even pulled real data — explicit input wins
      },
    } satisfies Plugin);
  });

  it("forecast still runs, honestly at $0, when no bridge secret is configured", async () => {
    const atlas = new Atlas({ guardian: new Guardian() }); // no KDP_CRON_SECRET at all
    await atlas.use(createMemoryPlugin({ store: new InMemoryStore() }));
    await atlas.use(createCfoPlugin({ fetcher: fakeRevenueFetch() }));
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:cfo", "call:memory"], role: "executor" },
      async register(ctx) {
        const result = (await ctx.call("cfo", { op: "forecast", inputs: { cashOnHand: 1000, monthlyExpenses: 500 } })) as { monthlyRevenue: number; realRevenueUsed: boolean };
        expect(result.monthlyRevenue).toBe(0);
        expect(result.realRevenueUsed).toBe(false);
      },
    } satisfies Plugin);
  });
});
