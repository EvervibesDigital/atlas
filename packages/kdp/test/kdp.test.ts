import { describe, it, expect } from "vitest";
import { Atlas, ConfigVault } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { createMemoryPlugin, InMemoryStore } from "@atlas/memory";
import { createKdpPlugin } from "../src/plugin";

function fakeFetch(handlers: Record<string, (init?: RequestInit) => unknown>): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const handler = handlers[path];
    if (!handler) throw new Error(`no fake handler for ${path}`);
    const body = handler(init);
    return { ok: true, status: 200, json: async () => body, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer } as Response;
  }) as typeof fetch;
}

describe("kdp plugin", () => {
  it("scan calls the trends-scan endpoint with the bearer secret", async () => {
    const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({ KDP_CRON_SECRET: "s3cret" }) });
    let sawAuth = "";
    const f = fakeFetch({
      "/api/cron/kdp-trends-scan": (init) => {
        sawAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
        return { ok: true, scanned: 12, inserted: 3 };
      },
    });
    await atlas.use(createKdpPlugin({ fetcher: f }));
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:kdp"], role: "executor" },
      async register(ctx) {
        const r = (await ctx.call("kdp", { op: "scan" })) as { inserted: number };
        expect(r.inserted).toBe(3);
      },
    });
    expect(sawAuth).toBe("Bearer s3cret");
  });

  it("generate posts a limit and files a memory note about what was built", async () => {
    const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({ KDP_CRON_SECRET: "s3cret" }) });
    await atlas.use(createMemoryPlugin({ store: new InMemoryStore() }));
    const f = fakeFetch({
      "/api/cron/kdp-auto-generate": () => ({ ok: true, generated: 2, built: [{ title: "Gratitude Journal" }, { title: "2027 Planner" }] }),
    });
    await atlas.use(createKdpPlugin({ fetcher: f }));
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:kdp", "call:memory"], role: "executor" },
      async register(ctx) {
        const r = (await ctx.call("kdp", { op: "generate", limit: 2 })) as { generated: number };
        expect(r.generated).toBe(2);
        const found = (await ctx.call("memory", { op: "search", query: "Gratitude Journal", options: { limit: 5 } })) as unknown[];
        expect(found.length).toBeGreaterThan(0);
      },
    });
  });

  it("throws a clear error when KDP_CRON_SECRET is missing", async () => {
    const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({}) });
    await atlas.use(createKdpPlugin({ fetcher: fakeFetch({}) }));
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:kdp"], role: "executor" },
      async register(ctx) {
        await expect(ctx.call("kdp", { op: "scan" })).rejects.toThrow(/KDP_CRON_SECRET/);
      },
    });
  });

  it("status returns opportunities and books from the bridge", async () => {
    const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({ KDP_CRON_SECRET: "s3cret" }) });
    const f = fakeFetch({
      "/api/kdp/status": () => ({ ok: true, opportunities: [{ id: "o1" }], books: [{ id: "b1", title: "Test Book" }] }),
    });
    await atlas.use(createKdpPlugin({ fetcher: f }));
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:kdp"], role: "executor" },
      async register(ctx) {
        const r = (await ctx.call("kdp", { op: "status" })) as { opportunities: unknown[]; books: unknown[] };
        expect(r.opportunities.length).toBe(1);
        expect(r.books.length).toBe(1);
      },
    });
  });
});
