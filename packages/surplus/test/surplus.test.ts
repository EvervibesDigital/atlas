import { describe, it, expect } from "vitest";
import { Atlas, ConfigVault } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { createMemoryPlugin, InMemoryStore } from "@atlas/memory";
import { TwinClient } from "../src/twin-client";
import { createSurplusPlugin, type SurplusCommand } from "../src/plugin";

// A fake fetch that routes by path+method, mirroring @atlas/kdp's test seam so
// none of these tests touch the real Twin API.
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

describe("TwinClient", () => {
  it("flattens the agent_name.name nesting from GET /v1/agents", async () => {
    const f = fakeFetch({
      "/v1/agents": () => ({ data: [{ agent_id: "a1", agent_name: { name: "Surplus Funds Lead Scraper" }, has_runs: true }] }),
    });
    const agents = await new TwinClient("twin_test", f).listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0]!.name).toBe("Surplus Funds Lead Scraper");
    expect(agents[0]!.agent_id).toBe("a1");
  });

  it("sends the x-api-key header on every request", async () => {
    let sawKey = "";
    const f = (async (_url: string, init?: RequestInit) => {
      sawKey = (init?.headers as Record<string, string>)["x-api-key"] ?? "";
      return { ok: true, status: 200, json: async () => ({ data: [] }) } as Response;
    }) as typeof fetch;
    await new TwinClient("twin_secret_key", f).listSchedules();
    expect(sawKey).toBe("twin_secret_key");
  });

  it("triggerRun POSTs run_mode 'run' and returns the run id", async () => {
    let sawBody: any = null;
    const f = fakeFetch({
      "POST /v1/agents/a1/runs": (init) => {
        sawBody = JSON.parse(String(init?.body));
        return { run_id: "run_123" };
      },
    });
    const res = await new TwinClient("k", f).triggerRun("a1", "go");
    expect(res.run_id).toBe("run_123");
    expect(sawBody.run_mode).toBe("run");
    expect(sawBody.user_message).toBe("go");
  });
});

describe("surplus plugin", () => {
  it("lists the surplus agents through the service, reading TWIN_API_KEY from the vault", async () => {
    const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({ TWIN_API_KEY: "twin_abc" }) });
    const f = fakeFetch({
      "/v1/agents": () => ({ data: [{ agent_id: "019cbebb", agent_name: { name: "Surplus Funds Lead Scraper" } }] }),
    });
    await atlas.use(createSurplusPlugin({ fetcher: f }));
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:surplus"], role: "executor" },
      async register(ctx) {
        const r = (await ctx.call("surplus", { op: "listAgents" } satisfies SurplusCommand)) as { agents: Array<{ name: string }> };
        expect(r.agents[0]!.name).toBe("Surplus Funds Lead Scraper");
      },
    });
  });

  it("maps a role to the right Twin agent id when triggering a run", async () => {
    const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({ TWIN_API_KEY: "twin_abc" }) });
    await atlas.use(createMemoryPlugin({ store: new InMemoryStore() }));
    let sawPath = "";
    const f = (async (url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET").toUpperCase() === "POST") sawPath = new URL(url).pathname;
      return { ok: true, status: 200, json: async () => ({ run_id: "r1" }) } as Response;
    }) as typeof fetch;
    await atlas.use(createSurplusPlugin({ fetcher: f }));
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:surplus", "call:memory"], role: "executor" },
      async register(ctx) {
        const r = (await ctx.call("surplus", { op: "run", role: "scraper" } satisfies SurplusCommand)) as { run_id?: string };
        expect(r.run_id).toBe("r1");
        expect(sawPath).toBe("/v1/agents/019cbebb-e091-7dc1-beee-0e9e9a8477ec/runs");
      },
    });
  });

  it("throws a clear error when TWIN_API_KEY is missing", async () => {
    const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({}) });
    await atlas.use(createSurplusPlugin());
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:surplus"], role: "executor" },
      async register(ctx) {
        await expect(ctx.call("surplus", { op: "listAgents" } satisfies SurplusCommand)).rejects.toThrow(/TWIN_API_KEY/);
      },
    });
  });
});
