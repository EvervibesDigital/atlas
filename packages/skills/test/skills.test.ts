import { describe, it, expect } from "vitest";
import { Atlas, type Plugin } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { createBrainPlugin } from "@atlas/brain";
import { createMemoryPlugin, InMemoryStore } from "@atlas/memory";
import { parseSkillDraft, SkillRegistry, createSkillsPlugin, type Skill } from "../src/index";

describe("parseSkillDraft", () => {
  it("extracts the system prompt and input hint", () => {
    const p = parseSkillDraft("SYSTEM: You are a pricing analyst who compares competitor plans.\nINPUT: a list of competitor prices", "pricing");
    expect(p.systemPrompt).toMatch(/pricing analyst/);
    expect(p.inputHint).toMatch(/competitor prices/);
  });
  it("falls back cleanly when the format is missing", () => {
    expect(parseSkillDraft("garbage", "cold email").systemPrompt).toMatch(/cold email/);
  });
});

describe("skills plugin", () => {
  it("invents a new skill and then runs it (offline stub brain)", async () => {
    const atlas = new Atlas({ guardian: new Guardian() });
    await atlas.use(createMemoryPlugin({ store: new InMemoryStore() }));
    await atlas.use(createBrainPlugin());
    await atlas.use(createSkillsPlugin({ registry: new SkillRegistry() }));

    let created: Skill | undefined;
    let ran: { output: string } | undefined;
    let list: Skill[] = [];
    await atlas.use({
      manifest: { name: "learner", version: "1", capabilities: [], permissions: ["call:skills"], role: "executor" },
      async register(ctx) {
        created = (await ctx.call("skills", { op: "create", name: "Competitor pricing analysis", category: "research", purpose: "analyze competitor pricing and find gaps" })) as Skill;
        ran = (await ctx.call("skills", { op: "run", id: created.id, input: "Competitor A: $29/mo, Competitor B: $49/mo" })) as { output: string };
        list = (await ctx.call("skills", { op: "list" })) as Skill[];
      },
    } satisfies Plugin);

    expect(created?.id).toBeTruthy();
    expect(created?.systemPrompt.length).toBeGreaterThan(0);
    expect(ran?.output.length).toBeGreaterThan(0);
    expect(list.find((s) => s.id === created!.id)?.timesRun).toBe(1);
  });
});
