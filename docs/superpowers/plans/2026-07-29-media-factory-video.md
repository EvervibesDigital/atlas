# Media Factory Video Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the real gap flagged in Plan 1: Media Factory produces images only today because `produceContentDraft`'s output is one script blob with one image, and `MontageRenderer` needs `{voice, scenes: [{text, imageUrl}]}`. This adds the missing step — break the already-drafted script into scenes, generate one character-consistent image per scene, render a real video — reusing Plan 1's async job queue rather than inventing a second one.

**Architecture:** A new `breakScriptIntoScenes` Brain call splits the existing script (no re-drafting) into N narration segments with per-segment visual prompts. A new `produceVideo` op on the media-factory plugin generates one image per scene (same character-sheet-consistency trick already used for single images) and enqueues a render job via the *existing* `publishing.enqueueRender` (Plan 1). `VideoRenderJob` gains an optional `contentId` field so, once the background worker (already running) finishes it, Media Factory can find its result and attach it to the content item.

**Tech Stack:** TypeScript, vitest, extends `@atlas/media-factory` and `@atlas/publishing`.

**Confirmed by reading the actual code, not assumed:** `MontageRenderer.render()`'s `spec.voice` field is never read by `synthesize()` — Piper always uses the one configured model. No per-creator voice selection to build; `creator.name` is a fine placeholder for the field the type requires.

---

### Task 1: `breakScriptIntoScenes`

**Files:**
- Modify: `packages/media-factory/src/agents.ts`
- Test: `packages/media-factory/test/agents.test.ts`

- [ ] **Step 1: Read the existing test file's fake-invoke pattern**

Run: `grep -n "BrainInvoker\|fakeInvoke\|async (s, p)" packages/media-factory/test/agents.test.ts`

Match whatever fake `invoke` function shape is already used there.

- [ ] **Step 2: Write the failing test**

Add to `packages/media-factory/test/agents.test.ts`:

```typescript
describe("breakScriptIntoScenes", () => {
  it("asks the brain to split the script and returns parsed scenes", async () => {
    const fakeInvoke = async (_service: string, _payload: unknown) => ({
      text: JSON.stringify({
        scenes: [
          { text: "Scene one narration.", image_prompt: "a person smiling at a desk" },
          { text: "Scene two narration.", image_prompt: "a person walking outside" },
        ],
      }),
    });

    const scenes = await MediaFactoryAgents.breakScriptIntoScenes(fakeInvoke, "Full script text here.", 2);

    expect(scenes).toHaveLength(2);
    expect(scenes[0]).toEqual({ text: "Scene one narration.", imagePrompt: "a person smiling at a desk" });
    expect(scenes[1]).toEqual({ text: "Scene two narration.", imagePrompt: "a person walking outside" });
  });

  it("throws a clear error if the brain returns unparseable output", async () => {
    const fakeInvoke = async () => ({ text: "not json" });
    await expect(MediaFactoryAgents.breakScriptIntoScenes(fakeInvoke, "script", 3)).rejects.toThrow();
  });
});
```

Check the top of the test file for how `MediaFactoryAgents` is imported (`grep -n "^import" packages/media-factory/test/agents.test.ts`) and match it.

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx vitest run packages/media-factory/test/agents.test.ts -t "breakScriptIntoScenes"`
Expected: FAIL — `MediaFactoryAgents.breakScriptIntoScenes` is not a function.

- [ ] **Step 4: Implement**

In `packages/media-factory/src/agents.ts`, inside the `MediaFactoryAgents` class (find it: `grep -n "class MediaFactoryAgents" packages/media-factory/src/agents.ts`), add a new static method (matching the existing `produceContentDraft`'s style — `extractJSON` is already imported/used in this file, reuse it):

```typescript
  /**
   * Splits an ALREADY-WRITTEN script into `sceneCount` narration segments,
   * each with its own visual prompt — does not re-draft the script's
   * content or voice, only breaks it up for video. This is the missing
   * step MontageRenderer needs (`{voice, scenes: [{text, imageUrl}]}`) that
   * produceContentDraft alone can't produce (one script, one image).
   */
  static async breakScriptIntoScenes(invoke: BrainInvoker, script: string, sceneCount: number): Promise<Array<{ text: string; imagePrompt: string }>> {
    const system = `You split an already-written script into exactly ${sceneCount} short narration segments for a short-form video, in order. Return ONLY strict JSON: {"scenes": [{"text": "segment of the script, verbatim or lightly trimmed for pacing", "image_prompt": "a distinct, high-detail photorealistic visual for this specific segment"}]}`;
    const prompt = `Script:\n${script}\n\nSplit this into exactly ${sceneCount} scenes, preserving the original wording as closely as possible while giving each segment a distinct visual moment.`;
    const resp = (await invoke("brain", { prompt, system, maxTokens: 1024, task: "media_factory.scenes" })) as { text: string };
    const parsed = extractJSON<{ scenes: Array<{ text: string; image_prompt: string }> }>(resp.text);
    return parsed.scenes.map((s) => ({ text: s.text, imagePrompt: s.image_prompt }));
  }
```

- [ ] **Step 5: Confirm it passes**

Run: `npx vitest run packages/media-factory/test/agents.test.ts`
Expected: all agents tests passing, including the 2 new ones.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/media-factory/src/agents.ts packages/media-factory/test/agents.test.ts
git commit -m "Add breakScriptIntoScenes: the missing step between a script and a video"
```

---

### Task 2: `VideoRenderJob` gains an optional `contentId`

**Files:**
- Modify: `packages/publishing/src/video-queue.ts`
- Modify: `packages/publishing/test/video-queue.test.ts`

Purely additive — every existing caller (the orchestrator's daily Reel, Plan 3's post-publish flow doesn't use this queue) keeps working unchanged; Media Factory is the first caller to actually set it.

- [ ] **Step 1: Write the failing test**

Add to `packages/publishing/test/video-queue.test.ts`, inside the existing `describe("enqueueJob", ...)` block:

```typescript
  it("carries an optional contentId through, when the caller provides one", () => {
    const jobs = enqueueJob([], { voice: "v", scenes: [] }, "content-item-42");
    expect(jobs[0]!.contentId).toBe("content-item-42");
  });

  it("leaves contentId undefined when the caller doesn't provide one", () => {
    const jobs = enqueueJob([], { voice: "v", scenes: [] });
    expect(jobs[0]!.contentId).toBeUndefined();
  });
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run packages/publishing/test/video-queue.test.ts -t "contentId"`
Expected: FAIL — `enqueueJob` doesn't accept a third argument yet, `contentId` is undefined either way (first assertion fails).

- [ ] **Step 3: Implement**

In `packages/publishing/src/video-queue.ts`:

```typescript
export interface VideoRenderJob {
  id: string;
  spec: unknown;
  /** Set when the caller wants to find this job again by content item
   * (Media Factory) rather than only by job id (the orchestrator's own
   * daily Reel doesn't set this — it has nothing to look it back up for). */
  contentId?: string;
  status: "queued" | "rendering" | "done" | "failed";
  requestedAt: string;
  completedAt?: string;
  resultPath?: string;
  error?: string;
}

export function enqueueJob(jobs: VideoRenderJob[], spec: unknown, contentId?: string): VideoRenderJob[] {
  return [...jobs, { id: randomUUID(), spec, contentId, status: "queued", requestedAt: new Date().toISOString() }];
}
```

- [ ] **Step 4: Confirm it passes**

Run: `npx vitest run packages/publishing/test/video-queue.test.ts`
Expected: all passing (8 existing + 2 new).

- [ ] **Step 5: Update the publishing plugin's `enqueueRender` to accept and forward it**

In `packages/publishing/src/plugin.ts`, find the `enqueueRender` branch (`grep -n 'op === "enqueueRender"' packages/publishing/src/plugin.ts`) and update it to accept an optional `contentId` from the command:

```typescript
        if (cmd.op === "enqueueRender") {
          const raw = await readFile(videoJobsPath, "utf8").catch(() => "[]");
          const existing = JSON.parse(raw) as VideoRenderJob[];
          const updated = enqueueJob(existing, cmd.spec, (cmd as { contentId?: string }).contentId);
          await writeFile(videoJobsPath, JSON.stringify(updated), "utf8");
          const job = updated[updated.length - 1]!;
          return { jobId: job.id };
        }
```

In `packages/publishing/src/types.ts`, add `contentId?: string` to the `enqueueRender` command variant:

```typescript
  | { op: "enqueueRender"; spec: { voice: string; scenes: Array<{ text: string; imageUrl: string }> }; contentId?: string }
```

- [ ] **Step 6: Typecheck and run publishing + media-factory suites**

Run: `npx tsc --noEmit -p tsconfig.json && npx vitest run packages/publishing`
Expected: clean typecheck, all passing.

- [ ] **Step 7: Commit**

```bash
git add packages/publishing/src/video-queue.ts packages/publishing/src/plugin.ts packages/publishing/src/types.ts packages/publishing/test/video-queue.test.ts
git commit -m "Let enqueueRender jobs carry an optional contentId for later lookup"
```

---

### Task 3: `produceVideo` op on the media-factory plugin

**Files:**
- Modify: `packages/media-factory/src/plugin.ts`
- Test: `packages/media-factory/test/produce-video.test.ts`

- [ ] **Step 1: Read the existing attachGeneratedImage function**

Run: `sed -n '60,90p' packages/media-factory/src/plugin.ts` (already read earlier this session — confirms the exact signature and character-sheet-consistency call shape to reuse per scene).

- [ ] **Step 2: Write the failing test**

Create `packages/media-factory/test/produce-video.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
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
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx vitest run packages/media-factory/test/produce-video.test.ts`
Expected: FAIL — `produceVideo` op doesn't exist.

- [ ] **Step 4: Implement**

In `packages/media-factory/src/plugin.ts`, add `"produceVideo"` to `MediaFactoryCommand`:

```typescript
  | { op: "produceVideo"; contentId: string };
```

Add a new branch inside `ctx.provide("mediaFactory", ...)`, near the existing `"produce"` handling:

```typescript
        if (cmd.op === "produceVideo") {
          const item = await MediaFactoryDB.getContentItem(cmd.contentId);
          if (!item) throw new Error(`mediaFactory: content item "${cmd.contentId}" not found`);
          if (!item.script) throw new Error(`mediaFactory: content item "${cmd.contentId}" has no script yet — run "produce" first`);
          const creator = await MediaFactoryDB.getCreator(item.creator_id);
          if (!creator) throw new Error(`mediaFactory: creator for content item "${cmd.contentId}" not found`);

          const SCENE_COUNT = 4;
          const scenes = await MediaFactoryAgents.breakScriptIntoScenes(invoke, item.script, SCENE_COUNT);

          const renderScenes: Array<{ text: string; imageUrl: string }> = [];
          for (const scene of scenes) {
            const assets = await attachGeneratedImage(creator, `${cmd.contentId}-scene-${renderScenes.length}`, scene.imagePrompt);
            const imageUrl = (assets as { image_path?: string }).image_path;
            if (imageUrl) renderScenes.push({ text: scene.text, imageUrl });
          }
          if (renderScenes.length === 0) throw new Error(`mediaFactory: no scene images generated for "${cmd.contentId}" — check GEMINI_API_KEY`);

          const { jobId } = (await ctx.call("publishing", {
            op: "enqueueRender",
            spec: { voice: creator.name, scenes: renderScenes },
            contentId: cmd.contentId,
          })) as { jobId: string };

          await MediaFactoryDB.updateContentItemDraft(cmd.contentId, { assets: { video_job_id: jobId } });
          return { jobId, sceneCount: renderScenes.length };
        }
```

Add `"call:publishing"` to the media-factory plugin's manifest `permissions` array if it isn't already there.

- [ ] **Step 5: Confirm it passes**

Run: `npx vitest run packages/media-factory/test/produce-video.test.ts`
Expected: passing (after replacing the scaffold per Step 2's note).

- [ ] **Step 6: Typecheck and run the full media-factory + publishing suites**

Run: `npx tsc --noEmit -p tsconfig.json && npx vitest run packages/media-factory packages/publishing`
Expected: clean typecheck, all passing.

- [ ] **Step 7: Commit**

```bash
git add packages/media-factory/src/plugin.ts packages/media-factory/test/produce-video.test.ts
git commit -m "Add produceVideo op: scenes -> per-scene images -> queued render job"
```

---

### Task 4: Deploy

**Files:** none (deploy-only task)

- [ ] **Step 1: Push and deploy**

```bash
git push origin main
scp -i ~/.ssh/atlas_deploy packages/media-factory/src/*.ts root@72.62.168.207:/opt/atlas/app/packages/media-factory/src/
scp -i ~/.ssh/atlas_deploy packages/publishing/src/*.ts root@72.62.168.207:/opt/atlas/app/packages/publishing/src/
ssh -i ~/.ssh/atlas_deploy root@72.62.168.207 "docker restart atlas && sleep 8 && curl -s -o /dev/null -w '%{http_code}\n' localhost:4317/api/health"
```

Expected: `200`, clean startup log.

---

## Next

`produceVideo` is manually/on-demand triggered (via `contentId`) in this plan — not yet wired into `autoCycle` automatically, deliberately: video generation costs more (4 image-gen calls + a render job vs. 1 image) and should be a deliberate choice per content item, not automatic for everything the moment it lands in review. Wiring an automatic trigger (e.g., "every 3rd post gets video") is a one-line follow-up once this is verified working end to end.
