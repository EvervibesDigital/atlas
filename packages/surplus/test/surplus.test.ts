import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { Atlas, ConfigVault } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { createMemoryPlugin, InMemoryStore } from "@atlas/memory";
import { TwinClient } from "../src/twin-client";
import { createSurplusPlugin, type SurplusCommand } from "../src/plugin";

// A real RSA key so pendingLeads' actual JWT-signing code path runs.
const TEST_PRIVATE_KEY_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

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

  // Real header row, verified live against Mat's actual Leads sheet on
  // 2026-07-25 (space-separated, NOT the underscore names the platform's own
  // SQLite schema uses internally) — an earlier version of this fixture used
  // underscore headers that happened to match a bug in the implementation
  // instead of catching it. Keep this fixture honest to the real sheet.
  const REAL_HEADER_ROW = [
    "lead id", "county", "state", "property address", "case number", "auction date",
    "sale price", "debt owed", "estimated surplus", "lead tier", "lead score",
    "owner name", "owner email", "owner phone", "owner mailing address",
    "source url", "date scraped", "email sent", "email sent date", "sms sent",
    "call attempted", "letter generated", "attorney assigned", "claim status",
    "estimated commission", "revenue collected",
  ];
  function leadsSheetFetch(rows: string[][]): typeof fetch {
    return (async (url: string) => {
      const u = new URL(url);
      if (u.pathname === "/token") return { ok: true, status: 200, json: async () => ({ access_token: "t" }) } as Response;
      if (u.pathname.includes("/values/")) {
        return { ok: true, status: 200, json: async () => ({ values: [REAL_HEADER_ROW, ...rows] }) } as Response;
      }
      throw new Error("unexpected path " + u.pathname);
    }) as typeof fetch;
  }

  it("pendingLeads filters to estimated surplus >= $5,000 against the real sheet header row", async () => {
    // Deliberately no TWIN_API_KEY in the vault — pendingLeads only needs the Sheets credential.
    const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({ GOOGLE_SHEETS_CLIENT_EMAIL: "svc@x.iam.gserviceaccount.com", GOOGLE_SHEETS_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM }) });
    const f = leadsSheetFetch([
      ["L1", "Marion", "IN", "123 Main St", "CASE-1", "2026-01-01", "$50,000", "$37,500", "$12,500", "Confirmed", "A", "Jane Doe", "jane@example.com", "", "", "", "", "", "", "", "", "", "", "", ""],
      ["L2", "Marion", "IN", "456 Oak Ave", "CASE-2", "2026-01-01", "$20,000", "$18,800", "$1,200", "Confirmed", "C", "John Smith", "", "", "", "", "", "", "", "", "", "", "", "", ""],
    ]);

    await atlas.use(createSurplusPlugin({ fetcher: f }));
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:surplus"], role: "executor" },
      async register(ctx) {
        const r = (await ctx.call("surplus", { op: "pendingLeads" } satisfies SurplusCommand)) as { leads: Array<{ case_number?: string; estimated_surplus?: number; owner_email?: string }> };
        expect(r.leads).toHaveLength(1);
        expect(r.leads[0]!.case_number).toBe("CASE-1");
        expect(r.leads[0]!.estimated_surplus).toBe(12500);
        expect(r.leads[0]!.owner_email).toBe("jane@example.com");
      },
    });
  });

  it("pendingLeads excludes leads whose 'email sent' column is already checked", async () => {
    const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({ GOOGLE_SHEETS_CLIENT_EMAIL: "svc@x.iam.gserviceaccount.com", GOOGLE_SHEETS_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM }) });
    const f = leadsSheetFetch([
      ["L1", "Marion", "IN", "123 Main St", "CASE-1", "2026-01-01", "$50,000", "$37,500", "$12,500", "Confirmed", "A", "Jane Doe", "", "", "", "", "", "Yes", "2026-01-05", "", "", "", "", "", ""],
      ["L2", "Marion", "IN", "789 Elm St", "CASE-2", "2026-01-01", "$60,000", "$44,000", "$16,000", "Confirmed", "A", "Bob Roe", "", "", "", "", "", "No", "", "", "", "", "", "", ""],
    ]);

    await atlas.use(createSurplusPlugin({ fetcher: f }));
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:surplus"], role: "executor" },
      async register(ctx) {
        const r = (await ctx.call("surplus", { op: "pendingLeads" } satisfies SurplusCommand)) as { leads: Array<{ case_number?: string }> };
        expect(r.leads).toHaveLength(1);
        expect(r.leads[0]!.case_number).toBe("CASE-2"); // CASE-1 already emailed, skipped
      },
    });
  });

  it("pendingLeads throws a clear error when the Sheets credential is missing", async () => {
    const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({}) });
    await atlas.use(createSurplusPlugin());
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:surplus"], role: "executor" },
      async register(ctx) {
        await expect(ctx.call("surplus", { op: "pendingLeads" } satisfies SurplusCommand)).rejects.toThrow(/GOOGLE_SHEETS/);
      },
    });
  });
});
