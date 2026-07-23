import { describe, it, expect } from "vitest";
import { Atlas, ConfigVault } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { createMemoryPlugin, InMemoryStore } from "@atlas/memory";
import { N8nClient } from "../src/n8n-client";
import { createOutreachPlugin } from "../src/plugin";
import type { OutreachCommand } from "../src/types";

function fakeFetch(handlers: Record<string, (init?: RequestInit) => unknown>): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const key = `${method} ${path}`;
    const handler = handlers[key] ?? handlers[path];
    if (!handler) throw new Error(`no fake handler for ${key}`);
    return { ok: true, status: 200, json: async () => handler(init) } as Response;
  }) as typeof fetch;
}

describe("N8nClient", () => {
  it("sends X-N8N-API-KEY on management API calls", async () => {
    let sawKey = "";
    const f = (async (_url: string, init?: RequestInit) => {
      sawKey = (init?.headers as Record<string, string>)["X-N8N-API-KEY"] ?? "";
      return { ok: true, status: 200, json: async () => ({ data: [] }) } as Response;
    }) as typeof fetch;
    await new N8nClient("n8n_secret", f).listWorkflows();
    expect(sawKey).toBe("n8n_secret");
  });

  it("triggerWebhook POSTs JSON to /webhook/<path> without the management API key", async () => {
    let sawPath = "";
    let sawKeyHeader: string | undefined;
    let sawBody: unknown = null;
    const f = (async (url: string, init?: RequestInit) => {
      sawPath = new URL(url).pathname;
      sawKeyHeader = (init?.headers as Record<string, string> | undefined)?.["X-N8N-API-KEY"];
      sawBody = JSON.parse(String(init?.body));
      return { ok: true, status: 200, json: async () => ({ received: true }) } as Response;
    }) as typeof fetch;
    const res = await new N8nClient("n8n_secret", f).triggerWebhook("new-lead", { businessName: "Joe's Plumbing" });
    expect(sawPath).toBe("/webhook/new-lead");
    expect(sawKeyHeader).toBeUndefined();
    expect(sawBody).toEqual({ businessName: "Joe's Plumbing" });
    expect(res).toEqual({ received: true });
  });

  it("setActive posts to /workflows/{id}/activate or /deactivate", async () => {
    const seen: string[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method} ${new URL(url).pathname}`);
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as typeof fetch;
    const c = new N8nClient("k", f);
    await c.setActive("wf1", true);
    await c.setActive("wf1", false);
    expect(seen).toEqual(["POST /api/v1/workflows/wf1/activate", "POST /api/v1/workflows/wf1/deactivate"]);
  });
});

describe("outreach plugin", () => {
  it("lists workflows through the service, reading N8N_API_KEY from the vault", async () => {
    const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({ N8N_API_KEY: "n8n_abc" }) });
    const f = fakeFetch({
      "/api/v1/workflows": () => ({ data: [{ id: "w1", name: "New Lead Intake", active: false }] }),
    });
    await atlas.use(createOutreachPlugin({ fetcher: f }));
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:outreach"], role: "executor" },
      async register(ctx) {
        const r = (await ctx.call("outreach", { op: "listWorkflows" } satisfies OutreachCommand)) as { workflows: Array<{ name: string }> };
        expect(r.workflows[0]!.name).toBe("New Lead Intake");
      },
    });
  });

  it("notify('new-lead', ...) triggers the right webhook and files a memory note", async () => {
    const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({ N8N_API_KEY: "n8n_abc" }) });
    await atlas.use(createMemoryPlugin({ store: new InMemoryStore() }));
    let sawPath = "";
    const f = (async (url: string) => {
      sawPath = new URL(url).pathname;
      return { ok: true, status: 200, json: async () => ({ received: true }) } as Response;
    }) as typeof fetch;
    await atlas.use(createOutreachPlugin({ fetcher: f }));
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:outreach", "call:memory"], role: "executor" },
      async register(ctx) {
        const r = (await ctx.call("outreach", { op: "notify", target: "new-lead", payload: { businessName: "Joe's Plumbing" } } satisfies OutreachCommand)) as { received: boolean };
        expect(r.received).toBe(true);
        expect(sawPath).toBe("/webhook/new-lead");

        const notes = (await ctx.call("memory", { op: "search", query: "Outreach: sent", options: { limit: 5 } })) as unknown[];
        expect(notes.length).toBeGreaterThan(0);
      },
    });
  });

  it("notify('deal-alert-sms', ...) and notify('bird-dog-verify', ...) hit their own distinct webhook paths", async () => {
    const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({ N8N_API_KEY: "n8n_abc" }) });
    const seenPaths: string[] = [];
    const f = (async (url: string) => {
      seenPaths.push(new URL(url).pathname);
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as typeof fetch;
    await atlas.use(createOutreachPlugin({ fetcher: f }));
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:outreach"], role: "executor" },
      async register(ctx) {
        await ctx.call("outreach", { op: "notify", target: "deal-alert-sms", payload: { dealId: "d1" } } satisfies OutreachCommand);
        await ctx.call("outreach", { op: "notify", target: "bird-dog-verify", payload: { leadId: "l1" } } satisfies OutreachCommand);
      },
    });
    expect(seenPaths).toEqual(["/webhook/deal-alert-sms", "/webhook/bird-dog-verify"]);
  });

  it("throws a clear error when N8N_API_KEY is missing", async () => {
    const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({}) });
    await atlas.use(createOutreachPlugin());
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:outreach"], role: "executor" },
      async register(ctx) {
        await expect(ctx.call("outreach", { op: "listWorkflows" } satisfies OutreachCommand)).rejects.toThrow(/N8N_API_KEY/);
      },
    });
  });
});
