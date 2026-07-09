import { describe, it, expect } from "vitest";
import { Atlas, type Plugin } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { createMemoryPlugin, InMemoryStore } from "@atlas/memory";
import { fetchIssues, createInboxPlugin, type FetchLike } from "../src/index";

const fakeIssues =
  (issues: unknown[]): FetchLike =>
  async () => ({ ok: true, status: 200, json: async () => issues });

describe("inbox", () => {
  it("fetches issues and skips pull requests", async () => {
    const msgs = await fetchIssues("EvervibesDigital/atlas", "tok", fakeIssues([
      { number: 1, title: "Focus on wholesale today", body: "prioritize leads" },
      { number: 2, title: "a PR", body: "", pull_request: {} },
    ]));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.title).toMatch(/wholesale/);
  });

  it("ingests new instructions into memory, deduped by issue number", async () => {
    const atlas = new Atlas({ guardian: new Guardian() });
    await atlas.use(createMemoryPlugin({ store: new InMemoryStore() }));
    await atlas.use(createInboxPlugin({ fetcher: fakeIssues([{ number: 7, title: "Study my Vercel deploys", body: "" }]) }));

    let first: { new: unknown[] } | undefined;
    let second: { new: unknown[] } | undefined;
    let recalled: unknown[] = [];
    await atlas.use({
      manifest: { name: "poller", version: "1", capabilities: [], permissions: ["call:inbox", "call:memory"], role: "executor" },
      async register(ctx) {
        first = (await ctx.call("inbox", { op: "check", repo: "EvervibesDigital/atlas", token: "tok" })) as { new: unknown[] };
        second = (await ctx.call("inbox", { op: "check", repo: "EvervibesDigital/atlas", token: "tok" })) as { new: unknown[] };
        recalled = (await ctx.call("memory", { op: "search", query: "Vercel deploys instruction" })) as unknown[];
      },
    } satisfies Plugin);

    expect(first!.new).toHaveLength(1); // ingested once
    expect(second!.new).toHaveLength(0); // deduped on the second check
    expect(recalled.length).toBeGreaterThan(0);
  });
});
