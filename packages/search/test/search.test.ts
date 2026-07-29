import { describe, it, expect } from "vitest";
import { Atlas, ConfigVault } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { createMemoryPlugin, InMemoryStore } from "@atlas/memory";
import { createApprovalsPlugin, ApprovalGateway } from "@atlas/approvals";
import { createActionsPlugin, type ActionRecord } from "@atlas/actions";
import { tavilySearch, serperSearch, githubRepoSearch, createSearchPlugin, type FetchLike, type SearchCommand } from "../src/index";

const fake =
  (payload: unknown): FetchLike =>
  async () => ({ ok: true, status: 200, json: async () => payload });

describe("search adapters", () => {
  it("normalizes Tavily results", async () => {
    const r = await tavilySearch("k", "free tts api", 3, fake({ results: [{ title: "edge-tts", url: "https://x", content: "free microsoft tts" }] }));
    expect(r[0]).toMatchObject({ title: "edge-tts", url: "https://x" });
  });
  it("normalizes Serper results", async () => {
    const r = await serperSearch("k", "q", 3, fake({ organic: [{ title: "T", link: "https://y", snippet: "s" }] }));
    expect(r[0]!.url).toBe("https://y");
  });
  it("normalizes GitHub repo search with stars", async () => {
    const r = await githubRepoSearch("tok", "ai agent", 3, fake({ items: [{ full_name: "org/agent", html_url: "https://gh", description: "cool", stargazers_count: 1200 }] }));
    expect(r[0]!.title).toBe("org/agent");
    expect(r[0]!.snippet).toContain("⭐1200");
  });
});

describe("scout -> approval-gated action for a genuinely viral repo", () => {
  function fakeGithub(items: Array<{ full_name: string; html_url: string; description?: string; stargazers_count: number }>): FetchLike {
    return (async () => ({ ok: true, status: 200, json: async () => ({ items }) })) as unknown as FetchLike;
  }

  async function buildTestAtlas(f: FetchLike) {
    const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({}) });
    await atlas.use(createMemoryPlugin({ store: new InMemoryStore() }));
    await atlas.use(createApprovalsPlugin({ gateway: new ApprovalGateway() }));
    await atlas.use(createActionsPlugin());
    await atlas.use(createSearchPlugin({ fetcher: f }));
    return atlas;
  }

  it("queues an approval-gated 'install' action for a repo past the viral star threshold", async () => {
    const atlas = await buildTestAtlas(fakeGithub([{ full_name: "org/viral-agent", html_url: "https://gh/org/viral-agent", description: "does cool stuff", stargazers_count: 24000 }]));
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:search", "call:actions"], role: "executor" },
      async register(ctx) {
        await ctx.call("search", { op: "scout", query: "ai agent framework" } satisfies SearchCommand);
        const actions = (await ctx.call("actions", { op: "list" })) as ActionRecord[];
        expect(actions).toHaveLength(1);
        expect(actions[0]!.status).toBe("pending-approval"); // never fires on its own
        expect(actions[0]!.request.title).toContain("org/viral-agent");
        expect(actions[0]!.request.type).toBe("install");
      },
    });
  });

  it("does not queue a second approval for a repo it already asked about, even across separate scout calls", async () => {
    // The real bug this guards against: a fixed hourly scout query kept
    // resurfacing the same top-starred repo as a brand-new approval every
    // cycle, regardless of Mat having already approved/rejected it — 63
    // duplicate entries for the same repo, none of which stopped the next
    // one from being queued.
    const atlas = await buildTestAtlas(fakeGithub([{ full_name: "0x4m4/hexstrike-ai", html_url: "https://gh/0x4m4/hexstrike-ai", description: "pentest MCP server", stargazers_count: 10500 }]));
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:search", "call:actions"], role: "executor" },
      async register(ctx) {
        await ctx.call("search", { op: "scout", query: "ai agent framework" } satisfies SearchCommand);
        await ctx.call("search", { op: "scout", query: "ai agent framework" } satisfies SearchCommand); // next hourly cycle, same top result
        await ctx.call("search", { op: "scout", query: "ai agent framework" } satisfies SearchCommand); // and again

        const actions = (await ctx.call("actions", { op: "list" })) as ActionRecord[];
        expect(actions).toHaveLength(1); // still only ever queued once
        expect(actions[0]!.request.title).toContain("hexstrike-ai");
      },
    });
  });

  it("does not queue an action for a repo that isn't actually viral", async () => {
    const atlas = await buildTestAtlas(fakeGithub([{ full_name: "org/tiny-tool", html_url: "https://gh/org/tiny-tool", description: "niche", stargazers_count: 12 }]));
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:search", "call:actions"], role: "executor" },
      async register(ctx) {
        await ctx.call("search", { op: "scout", query: "ai agent framework" } satisfies SearchCommand);
        const actions = (await ctx.call("actions", { op: "list" })) as ActionRecord[];
        expect(actions).toHaveLength(0);
      },
    });
  });

  it("still files every result to memory regardless of the action-queue threshold", async () => {
    const atlas = await buildTestAtlas(fakeGithub([{ full_name: "org/tiny-tool", html_url: "https://gh/org/tiny-tool", description: "niche", stargazers_count: 12 }]));
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:search", "call:memory"], role: "executor" },
      async register(ctx) {
        await ctx.call("search", { op: "scout", query: "ai agent framework" } satisfies SearchCommand);
        const notes = (await ctx.call("memory", { op: "search", query: "tiny-tool", options: { limit: 5 } })) as unknown[];
        expect(notes.length).toBeGreaterThan(0);
      },
    });
  });

  it("never queues an action when the actions plugin isn't registered (memory-only still works)", async () => {
    const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({}) });
    await atlas.use(createMemoryPlugin({ store: new InMemoryStore() }));
    await atlas.use(createSearchPlugin({ fetcher: fakeGithub([{ full_name: "org/viral-agent", html_url: "https://gh", description: "x", stargazers_count: 50000 }]) }));
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:search"], role: "executor" },
      async register(ctx) {
        // Must not throw even though "actions" has no provider.
        const r = (await ctx.call("search", { op: "scout", query: "ai agent framework" } satisfies SearchCommand)) as { results: unknown[] };
        expect(r.results).toHaveLength(1);
      },
    });
  });
});
