import { describe, it, expect } from "vitest";
import { Atlas, type Plugin } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { createBrainPlugin } from "@atlas/brain";
import { createMemoryPlugin, InMemoryStore } from "@atlas/memory";
import { findDuplicates, summarizeMemory, createRedTeamPlugin, createLegacyPlugin } from "../src/index";

describe("janitor helpers", () => {
  it("counts duplicate memory records", () => {
    expect(findDuplicates([{ content: "a" }, { content: "A " }, { content: "b" }])).toBe(1);
  });
  it("summarizes memory by kind", () => {
    const s = summarizeMemory([{ kind: "business", content: "x" }, { kind: "business", content: "y" }, { kind: "success", content: "z" }]);
    expect(s.total).toBe(3);
    expect(s.byKind.business).toBe(2);
  });
});

describe("red team + legacy through the kernel", () => {
  it("red team returns a critique", async () => {
    const atlas = new Atlas({ guardian: new Guardian() });
    await atlas.use(createMemoryPlugin({ store: new InMemoryStore() }));
    await atlas.use(createBrainPlugin());
    await atlas.use(createRedTeamPlugin());
    let out: { critique: string } | undefined;
    await atlas.use({
      manifest: { name: "c", version: "1", capabilities: [], permissions: ["call:redteam"], role: "executor" },
      async register(ctx) {
        out = (await ctx.call("redteam", { op: "challenge", idea: "Launch an AI receptionist SaaS for dentists" })) as { critique: string };
      },
    } satisfies Plugin);
    expect(out?.critique.length).toBeGreaterThan(0);
  });

  it("legacy learns a preference then advises", async () => {
    const atlas = new Atlas({ guardian: new Guardian() });
    await atlas.use(createMemoryPlugin({ store: new InMemoryStore() }));
    await atlas.use(createBrainPlugin());
    await atlas.use(createLegacyPlugin());
    let advice: { advice: string } | undefined;
    await atlas.use({
      manifest: { name: "c2", version: "1", capabilities: [], permissions: ["call:legacy"], role: "executor" },
      async register(ctx) {
        await ctx.call("legacy", { op: "learn", decision: "Chose the free tool over the paid one", rationale: "stay lean" });
        advice = (await ctx.call("legacy", { op: "advise", question: "Paid analytics or free?", options: ["paid", "free"] })) as { advice: string };
      },
    } satisfies Plugin);
    expect(advice?.advice.length).toBeGreaterThan(0);
  });
});
