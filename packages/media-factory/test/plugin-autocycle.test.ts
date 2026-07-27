import { describe, it, expect, vi, beforeEach } from "vitest";
import { Atlas, type GuardianLike } from "@atlas/core";
import type { VirtualCreator, ContentItem } from "../src/db";

// autoCycle's per-creator loop is the thing under test here — MediaFactoryDB
// (real Postgres via a module-level pool) and MediaFactoryAgents (real brain
// calls) are mocked at the same boundary plugin.ts itself calls them at, so
// this runs with no real DB/network. vi.hoisted is required because
// vi.mock's factory is hoisted above these imports.
const { listCreatorsMock, listContentItemsMock, updateContentItemDraftMock, produceContentDraftMock } = vi.hoisted(() => ({
  listCreatorsMock: vi.fn(),
  listContentItemsMock: vi.fn(),
  updateContentItemDraftMock: vi.fn(),
  produceContentDraftMock: vi.fn(),
}));

vi.mock("../src/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db")>();
  return {
    ...actual,
    MediaFactoryDB: {
      ...actual.MediaFactoryDB,
      listCreators: listCreatorsMock,
      listContentItems: listContentItemsMock,
      updateContentItemDraft: updateContentItemDraftMock,
    },
  };
});

vi.mock("../src/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents")>();
  return {
    ...actual,
    MediaFactoryAgents: {
      ...actual.MediaFactoryAgents,
      produceContentDraft: produceContentDraftMock,
    },
  };
});

const { createMediaFactoryPlugin } = await import("../src/plugin");

function permissiveGuardian(): GuardianLike {
  return {
    grant: () => {},
    check: () => ({ decision: "allow", reason: "test" }),
  };
}

function creator(id: string, name: string): VirtualCreator {
  return {
    id,
    name,
    handle: "@" + name,
    age_range: "25-34",
    gender: "female",
    appearance_profile: {},
    personality_traits: [],
    speaking_style: "",
    humor_style: "",
    values_statement: "",
    background_story: "",
    interests: [],
    content_pillars: ["fitness"],
    target_audience: {},
    brand_positioning: "",
  };
}

function planned(id: string, creatorId: string, title: string): ContentItem {
  return { id, creator_id: creatorId, platform: "instagram", status: "planned", title };
}

describe("mediaFactory autoCycle — per-creator throughput", () => {
  beforeEach(() => {
    listCreatorsMock.mockReset();
    listContentItemsMock.mockReset();
    updateContentItemDraftMock.mockReset();
    produceContentDraftMock.mockReset();
  });

  it("produces one item for EVERY eligible creator in a single call, not just the globally-oldest item", async () => {
    listCreatorsMock.mockResolvedValue([creator("c1", "Aria"), creator("c2", "Kai")]);
    listContentItemsMock.mockResolvedValue([planned("i1", "c1", "t1"), planned("i2", "c2", "t2")]);
    produceContentDraftMock.mockImplementation(async (_invoke, c: VirtualCreator) => ({
      script: `script for ${c.name}`,
      caption: "caption",
      hashtags: [],
      image_prompt: undefined,
    }));
    updateContentItemDraftMock.mockImplementation(async (id: string, draft: Record<string, unknown>) => ({ id, status: draft.status }));

    const atlas = new Atlas({ guardian: permissiveGuardian() });
    await atlas.use(createMediaFactoryPlugin());

    const result = (await atlas.invoke("mediaFactory", { op: "autoCycle" })) as {
      action: string;
      itemsProcessed: number;
      items: Array<{ creator: string }>;
    };

    expect(result.action).toBe("produced");
    expect(result.itemsProcessed).toBe(2);
    expect(result.items.map((i) => i.creator).sort()).toEqual(["Aria", "Kai"]);
    expect(produceContentDraftMock).toHaveBeenCalledTimes(2);
  });

  it("excludes a creator who already hit today's target, even though they still have a pending item", async () => {
    // c1 has already had DAILY_POST_TARGET (2) items scripted in the last
    // 24h — creatorsWithRoom must exclude them even though item i3 is still
    // sitting there ready to produce. c2 has room and gets processed.
    const now = new Date().toISOString();
    listCreatorsMock.mockResolvedValue([creator("c1", "Aria"), creator("c2", "Kai")]);
    listContentItemsMock.mockResolvedValue([
      { id: "i1", creator_id: "c1", platform: "instagram", status: "review", title: "done1", script: "s1", created_at: now },
      { id: "i2", creator_id: "c1", platform: "instagram", status: "review", title: "done2", script: "s2", created_at: now },
      planned("i3", "c1", "still pending"), // c1 has room in the queue but not under today's target
      planned("i4", "c2", "t4"),
    ]);
    produceContentDraftMock.mockImplementation(async (_invoke, c: VirtualCreator) => ({ script: `script for ${c.name}`, caption: "c", hashtags: [] }));
    updateContentItemDraftMock.mockResolvedValue({ id: "i4", status: "review" });

    const atlas = new Atlas({ guardian: permissiveGuardian() });
    await atlas.use(createMediaFactoryPlugin());

    const result = (await atlas.invoke("mediaFactory", { op: "autoCycle" })) as { itemsProcessed: number; items: Array<{ creator: string }> };
    expect(result.itemsProcessed).toBe(1);
    expect(result.items.map((i) => i.creator)).toEqual(["Kai"]);
  });

  it("skips entirely when there are no creators", async () => {
    listCreatorsMock.mockResolvedValue([]);
    const atlas = new Atlas({ guardian: permissiveGuardian() });
    await atlas.use(createMediaFactoryPlugin());

    const result = (await atlas.invoke("mediaFactory", { op: "autoCycle" })) as { skipped?: string };
    expect(result.skipped).toBeTruthy();
    expect(produceContentDraftMock).not.toHaveBeenCalled();
  });
});
