import { describe, it, expect } from "vitest";
import { itemsScriptedInLast24h, creatorsWithRoom, DAILY_POST_TARGET } from "../src/throughput";
import type { ContentItem, VirtualCreator } from "../src/db";

function item(creatorId: string, hoursAgo: number, scripted: boolean): ContentItem {
  const created = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  return {
    creator_id: creatorId,
    platform: "instagram",
    status: "planned",
    title: "t",
    script: scripted ? "a script" : undefined,
    created_at: created,
  };
}

function creator(id: string): VirtualCreator {
  return {
    id,
    name: id,
    handle: "@" + id,
    age_range: "25-34",
    gender: "female",
    appearance_profile: {},
    personality_traits: [],
    speaking_style: "",
    humor_style: "",
    values_statement: "",
    background_story: "",
    interests: [],
    content_pillars: [],
    target_audience: {},
    brand_positioning: "",
  };
}

describe("itemsScriptedInLast24h", () => {
  it("counts only scripted items from this creator within the last 24 hours", () => {
    const items = [
      item("c1", 1, true), // counts
      item("c1", 23, true), // counts
      item("c1", 25, true), // too old, doesn't count
      item("c1", 1, false), // not scripted yet, doesn't count
      item("c2", 1, true), // different creator, doesn't count
    ];
    expect(itemsScriptedInLast24h(items, "c1")).toBe(2);
  });

  it("is zero when the creator has nothing", () => {
    expect(itemsScriptedInLast24h([], "c1")).toBe(0);
  });
});

describe("creatorsWithRoom", () => {
  it("excludes creators who already hit today's target", () => {
    const creators = [creator("c1"), creator("c2")];
    const items = [
      item("c1", 1, true),
      item("c1", 2, true),
      // c2 has none yet
    ];
    const result = creatorsWithRoom(creators, items, DAILY_POST_TARGET);
    expect(result.map((c) => c.id)).toEqual(["c2"]);
  });

  it("includes every creator when none have produced anything today", () => {
    const creators = [creator("c1"), creator("c2"), creator("c3")];
    expect(creatorsWithRoom(creators, [], DAILY_POST_TARGET).length).toBe(3);
  });
});
