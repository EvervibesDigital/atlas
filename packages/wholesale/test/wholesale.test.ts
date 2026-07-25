import { describe, it, expect } from "vitest";
import { Atlas, ConfigVault } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { createWholesalePlugin } from "../src/plugin";
import type { WholesaleCommand } from "../src/types";

function fakeFetch(handlers: Record<string, (init?: RequestInit) => unknown>): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const handler = handlers[path];
    if (!handler) throw new Error(`no fake handler for ${path}`);
    const body = handler(init);
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;
}

describe("wholesale plugin", () => {
  it("list calls the pending-actions endpoint with the bearer secret", async () => {
    const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({ KDP_CRON_SECRET: "s3cret" }) });
    let sawAuth = "";
    const f = fakeFetch({
      "/api/wholesale/pending-actions/list": (init) => {
        sawAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
        return { ok: true, count: 1, actions: [{ id: "a1", action_type: "deal_blast", status: "pending", roi_score: 12000, target_count: 25, target_summary: "25 matched cash buyers", reason: "$12,000 spread", payload: {}, expires_at: null, created_at: "2026-07-25T00:00:00Z" }] };
      },
    });
    await atlas.use(createWholesalePlugin({ fetcher: f }));
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:wholesale"], role: "executor" },
      async register(ctx) {
        const r = (await ctx.call("wholesale", { op: "list" } satisfies WholesaleCommand)) as { actions: Array<{ id: string; roi_score: number }> };
        expect(r.actions).toHaveLength(1);
        expect(r.actions[0]!.roi_score).toBe(12000);
      },
    });
    expect(sawAuth).toBe("Bearer s3cret");
  });

  it("approve POSTs to the right action id", async () => {
    const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({ KDP_CRON_SECRET: "s3cret" }) });
    let sawPath = "";
    const f = fakeFetch({
      "/api/wholesale/pending-actions/a1/approve": () => {
        sawPath = "/api/wholesale/pending-actions/a1/approve";
        return { ok: true, fire_result: { sent: true } };
      },
    });
    await atlas.use(createWholesalePlugin({ fetcher: f }));
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:wholesale"], role: "executor" },
      async register(ctx) {
        const r = (await ctx.call("wholesale", { op: "approve", id: "a1" } satisfies WholesaleCommand)) as { ok: boolean };
        expect(r.ok).toBe(true);
      },
    });
    expect(sawPath).toBe("/api/wholesale/pending-actions/a1/approve");
  });

  it("veto POSTs a reason to the right action id", async () => {
    const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({ KDP_CRON_SECRET: "s3cret" }) });
    let sawBody: any = null;
    const f = fakeFetch({
      "/api/wholesale/pending-actions/a1/veto": (init) => {
        sawBody = JSON.parse(String(init?.body));
        return { ok: true };
      },
    });
    await atlas.use(createWholesalePlugin({ fetcher: f }));
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:wholesale"], role: "executor" },
      async register(ctx) {
        await ctx.call("wholesale", { op: "veto", id: "a1" } satisfies WholesaleCommand);
      },
    });
    expect(sawBody.reason).toBe("atlas_brief_reject");
  });

  it("throws a clear error when KDP_CRON_SECRET is missing", async () => {
    const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({}) });
    await atlas.use(createWholesalePlugin());
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:wholesale"], role: "executor" },
      async register(ctx) {
        await expect(ctx.call("wholesale", { op: "list" } satisfies WholesaleCommand)).rejects.toThrow(/KDP_CRON_SECRET/);
      },
    });
  });
});
