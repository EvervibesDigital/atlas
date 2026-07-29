import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Atlas, ConfigVault, type GuardianLike } from "@atlas/core";
import type { VirtualCreator, ContentItem } from "../src/db";

const { getContentItemMock, getCreatorMock, updateContentItemDraftMock, breakScriptIntoScenesMock } = vi.hoisted(() => ({
  getContentItemMock: vi.fn(),
  getCreatorMock: vi.fn(),
  updateContentItemDraftMock: vi.fn(),
  breakScriptIntoScenesMock: vi.fn(),
}));

vi.mock("../src/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db")>();
  return {
    ...actual,
    MediaFactoryDB: { ...actual.MediaFactoryDB, getContentItem: getContentItemMock, getCreator: getCreatorMock, updateContentItemDraft: updateContentItemDraftMock },
  };
});

vi.mock("../src/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents")>();
  return { ...actual, MediaFactoryAgents: { ...actual.MediaFactoryAgents, breakScriptIntoScenes: breakScriptIntoScenesMock } };
});

const { createMediaFactoryPlugin } = await import("../src/plugin");

function permissiveGuardian(): GuardianLike {
  return { grant: () => {}, check: () => ({ decision: "allow", reason: "test" }) };
}

function creator(id: string, name: string): VirtualCreator {
  return {
    id, name, handle: "@" + name, age_range: "25-34", gender: "female",
    appearance_profile: { description: "a woman with red hair, green eyes" }, personality_traits: [], speaking_style: "", humor_style: "",
    values_statement: "", background_story: "", interests: [], content_pillars: [], target_audience: {}, brand_positioning: "",
  };
}

describe("mediaFactory produceVideo", () => {
  let imagesDir: string;

  beforeEach(async () => {
    imagesDir = await mkdtemp(join(tmpdir(), "atlas-media-factory-video-test-"));
    getContentItemMock.mockReset();
    getCreatorMock.mockReset();
    updateContentItemDraftMock.mockReset();
    breakScriptIntoScenesMock.mockReset();
  });

  afterEach(async () => {
    await rm(imagesDir, { recursive: true, force: true });
  });

  it("breaks the script into scenes, generates one image each, and enqueues a render job", async () => {
    const item: ContentItem = { id: "item1", creator_id: "c1", platform: "instagram", status: "review", title: "t", script: "Full script here." };
    getContentItemMock.mockResolvedValue(item);
    getCreatorMock.mockResolvedValue(creator("c1", "Aria"));
    breakScriptIntoScenesMock.mockResolvedValue([
      { text: "Scene one.", imagePrompt: "prompt one" },
      { text: "Scene two.", imagePrompt: "prompt two" },
    ]);
    updateContentItemDraftMock.mockResolvedValue({ ...item });

    const imageFetcher = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: Buffer.from("fake-image-bytes").toString("base64") } }] } }] }),
    });

    const atlas = new Atlas({ guardian: permissiveGuardian(), config: new ConfigVault({ GEMINI_API_KEY: "FAKE_KEY" }) });
    let enqueuedSpec: unknown = null;
    let enqueuedContentId: string | undefined;
    await atlas.use({
      manifest: { name: "publishing", version: "1", capabilities: ["publishing"], permissions: [], role: "executor" },
      register(ctx) {
        ctx.provide("publishing", async (payload: unknown) => {
          const cmd = payload as { op: string; spec?: unknown; contentId?: string };
          if (cmd.op === "enqueueRender") { enqueuedSpec = cmd.spec; enqueuedContentId = cmd.contentId; return { jobId: "job1" }; }
          throw new Error("unexpected publishing op in test: " + cmd.op);
        });
      },
    });
    await atlas.use(createMediaFactoryPlugin({ imagesDir, imageFetcher: imageFetcher as any }));

    const result = (await atlas.invoke("mediaFactory", { op: "produceVideo", contentId: "item1" })) as { jobId: string; sceneCount: number };

    expect(result.jobId).toBe("job1");
    expect(result.sceneCount).toBe(2);
    expect(enqueuedContentId).toBe("item1");
    const spec = enqueuedSpec as { voice: string; scenes: Array<{ text: string; imageUrl: string }> };
    expect(spec.scenes).toHaveLength(2);
    expect(spec.scenes[0]!.text).toBe("Scene one.");
    expect(spec.scenes[0]!.imageUrl).toBeTruthy();
    expect(updateContentItemDraftMock).toHaveBeenCalledWith("item1", expect.objectContaining({ assets: expect.objectContaining({ video_job_id: "job1" }) }));
  });

  it("throws a clear error when the content item has no script yet", async () => {
    getContentItemMock.mockResolvedValue({ id: "item1", creator_id: "c1", platform: "instagram", status: "planned", title: "t" });
    const atlas = new Atlas({ guardian: permissiveGuardian(), config: new ConfigVault({ GEMINI_API_KEY: "FAKE_KEY" }) });
    await atlas.use(createMediaFactoryPlugin({ imagesDir }));
    await expect(atlas.invoke("mediaFactory", { op: "produceVideo", contentId: "item1" })).rejects.toThrow(/no script/);
  });
});
