# Media Factory Scaling Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the confirmed throughput bottleneck blocking Media Factory from supporting 10 influencer creators each posting multiple times a day (`autoCycle` currently advances only ONE item per hourly cycle system-wide, not per creator), and replace the 30-second inline video-render timeout with a background job queue so rendering never silently degrades to image-only under real load.

**Architecture:** `autoCycle` gains a bounded loop that processes one item for every creator that still has room under today's shared daily target, instead of always picking the single globally-oldest item. Video rendering moves from a synchronous inline call to an enqueue-and-poll job queue backed by a JSON file (same pattern as `automation.json`/`brief-digest.json`), processed by a new lightweight interval independent of the hourly business cycle so a slow render never blocks anything else.

**Important scope note, found while reading the actual code (not assumed):** Media Factory's per-creator pipeline (Tasks 1-3 below) currently only generates images — there is no video generation anywhere in the per-creator content path today. The only video rendering in the whole codebase is for ATLAS's own single daily Reel (a completely separate flow: `creative.writeReel` → `publishing.render`, unrelated to Media Factory's `content_items`). Tasks 4-6 fix that ONE render path's blocking-timeout problem and build reusable async-rendering infrastructure, but do not by themselves give the 10 creators video output — see Task 8, which wires video generation into Media Factory itself using that same infrastructure. Both pieces matter: without Tasks 4-6 the job queue doesn't exist yet to build on; without Task 8, Media Factory still can't produce video at all regardless of how good the queue is.

**Tech Stack:** TypeScript, vitest, existing `@atlas/media-factory` and `@atlas/publishing` packages, no new dependencies.

**Plan 1 of 3** for the AI Influencer Social Platform (see `docs/superpowers/specs/2026-07-27-social-media-platform-design.md`). Plans 2 (account connection + posting) and 3 (comment/DM auto-reply) follow once this lands — they depend on content actually being produced reliably, which is what this plan fixes.

---

### Task 1: `created_at` on `ContentItem` (unlocks daily-count tracking)

**Files:**
- Modify: `packages/media-factory/src/db.ts:59-73` (the `ContentItem` interface)
- Test: `packages/media-factory/test/db.test.ts` (create if it doesn't exist)

The SQL already returns `created_at` (`SELECT * FROM public.content_items ...`) — it's just missing from the TypeScript interface, so nothing downstream can use it. No migration needed, this is a type-only fix.

- [ ] **Step 1: Check whether a db test file already exists**

Run: `ls packages/media-factory/test/`

If `db.test.ts` doesn't exist, the next steps create it. If it does, skip to Step 3 and add the test there instead.

- [ ] **Step 2: Write the failing test**

Create `packages/media-factory/test/db.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type { ContentItem } from "../src/db";

describe("ContentItem type", () => {
  it("includes created_at, since the underlying SQL already returns it", () => {
    // Compile-time check: this assignment must type-check. If created_at
    // isn't on the interface, TypeScript rejects this file.
    const item: ContentItem = {
      creator_id: "c1",
      platform: "instagram",
      status: "planned",
      title: "t",
      created_at: "2026-07-27T00:00:00.000Z",
    };
    expect(item.created_at).toBe("2026-07-27T00:00:00.000Z");
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: `error TS2353: Object literal may only specify known properties, and 'created_at' does not exist in type 'ContentItem'.`

- [ ] **Step 4: Add the field**

In `packages/media-factory/src/db.ts`, add one line to the `ContentItem` interface (around line 71, after `approval_id`):

```typescript
  approval_id?: string;
  created_at?: string;
```

- [ ] **Step 5: Confirm the test now passes**

Run: `npx tsc --noEmit -p tsconfig.json && npx vitest run packages/media-factory/test/db.test.ts`
Expected: typecheck clean, 1 test passing.

- [ ] **Step 6: Commit**

```bash
git add packages/media-factory/src/db.ts packages/media-factory/test/db.test.ts
git commit -m "Expose created_at on ContentItem (already returned by SQL, just untyped)"
```

---

### Task 2: Pure throughput-decision helper

**Files:**
- Create: `packages/media-factory/src/throughput.ts`
- Test: `packages/media-factory/test/throughput.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/media-factory/test/throughput.test.ts`:

```typescript
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
      item("c1", 1, true),   // counts
      item("c1", 23, true),  // counts
      item("c1", 25, true),  // too old, doesn't count
      item("c1", 1, false),  // not scripted yet, doesn't count
      item("c2", 1, true),   // different creator, doesn't count
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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run packages/media-factory/test/throughput.test.ts`
Expected: FAIL — `Failed to load url ../src/throughput` (module doesn't exist yet).

- [ ] **Step 3: Implement**

Create `packages/media-factory/src/throughput.ts`:

```typescript
import type { ContentItem, VirtualCreator } from "./db";

/**
 * How many posts each creator gets scripted per rolling 24h window before
 * autoCycle stops giving them more room, so one creator's backlog can't
 * starve the other nine. One shared constant for now (not per-creator DB
 * config) — simplest fix for the real bottleneck; per-creator tuning is a
 * natural follow-up if wanted later, not needed to unblock scaling.
 */
export const DAILY_POST_TARGET = 2;

/** Items for `creatorId` that have actually been scripted (not just planned)
 * within the last 24 hours — the throughput autoCycle is meant to pace. */
export function itemsScriptedInLast24h(items: ContentItem[], creatorId: string): number {
  const cutoff = Date.now() - 24 * 3_600_000;
  return items.filter(
    (i) => i.creator_id === creatorId && Boolean(i.script) && i.created_at !== undefined && new Date(i.created_at).getTime() >= cutoff,
  ).length;
}

/** Creators who haven't hit today's target yet, in the same order they were
 * given — autoCycle gives each of these one unit of work per call. */
export function creatorsWithRoom(creators: VirtualCreator[], items: ContentItem[], target: number): VirtualCreator[] {
  return creators.filter((c) => itemsScriptedInLast24h(items, c.id!) < target);
}
```

- [ ] **Step 4: Confirm it passes**

Run: `npx vitest run packages/media-factory/test/throughput.test.ts`
Expected: 4 tests passing.

- [ ] **Step 5: Commit**

```bash
git add packages/media-factory/src/throughput.ts packages/media-factory/test/throughput.test.ts
git commit -m "Add pure throughput-pacing helpers for Media Factory's per-creator daily target"
```

---

### Task 3: Wire the throughput fix into `autoCycle`

**Files:**
- Modify: `packages/media-factory/src/plugin.ts:118-144` (the `autoCycle` function's "produce" branch)
- Test: `packages/media-factory/test/plugin.test.ts` (existing — add to it)

The exact current code being replaced (confirmed by reading the file directly):

```typescript
        // Find the oldest unscripted "planned" item across all creators.
        const pending = allContent
          .filter((i) => i.status === "planned" && !i.script)
          .sort((a, b) => (a.id! < b.id! ? -1 : 1)); // stable-ish; created_at not selected in list query today
        const next = pending[0];
        if (!next) return { skipped: "every creator's queue is caught up — nothing to produce right now" };

        const creator = creators.find((c) => c.id === next.creator_id);
        if (!creator) return { skipped: `creator for content item ${next.id} not found` };

        const brief = (next.assets as { brief?: string } | undefined)?.brief ?? "";
        const draft = (await MediaFactoryAgents.produceContentDraft(invoke, creator, next.title, next.hook ?? "", brief, next.platform)) as {
          script?: string;
          caption?: string;
          hashtags?: string[];
          image_prompt?: string;
        };
        const imageAssets = await attachGeneratedImage(creator, next.id!, draft.image_prompt);
        const updated = await MediaFactoryDB.updateContentItemDraft(next.id!, {
          script: draft.script,
          caption: draft.caption,
          hashtags: draft.hashtags,
          assets: imageAssets,
          status: "review",
        });
        await ctx.emit("mediaFactory.produced", { creatorId: creator.id, contentId: next.id });
        return { action: "produced", creator: creator.name, title: next.title, status: updated.status, draft, imagePath: imageAssets.image_path };
```

This picks the single globally-oldest pending item across every creator, produces it (script+caption+hashtags via the brain, then an image), and returns. The fix: pick one pending item PER eligible creator instead of one globally, looping over `creatorsWithRoom`.

- [ ] **Step 1: Write the failing test**

Find the existing `describe("autoCycle"` block in `packages/media-factory/test/plugin.test.ts` (run `grep -n "autoCycle" packages/media-factory/test/plugin.test.ts` to locate it and see the exact fixture helpers already in use — e.g. how creators/content items are seeded into the fake DB in the existing tests) and add a test matching that same fixture style:

```typescript
it("produces one item for EVERY creator with room, not just one creator total", async () => {
  // Two creators, each with exactly one planned-unscripted item waiting.
  // Before the fix, only the globally-oldest item (creator 1's) would be
  // produced; after, both creators get one each in a single autoCycle call.
  seedCreators([
    { id: "c1", name: "Aria", content_pillars: ["fitness"] },
    { id: "c2", name: "Kai", content_pillars: ["tech"] },
  ]);
  seedContentItems([
    { id: "i1", creator_id: "c1", platform: "instagram", status: "planned", title: "t1" },
    { id: "i2", creator_id: "c2", platform: "instagram", status: "planned", title: "t2" },
  ]);

  const result = (await ctx.invoke("mediaFactory", { op: "autoCycle" })) as { action: string; itemsProcessed: number; items: Array<{ creator: string }> };

  expect(result.action).toBe("produced");
  expect(result.itemsProcessed).toBe(2);
  expect(result.items.map((i) => i.creator).sort()).toEqual(["Aria", "Kai"]);
});
```

Replace `seedCreators`/`seedContentItems`/`ctx` with whatever the file's existing tests actually call them — copy the exact setup pattern from the test immediately above this one in the same file rather than guessing at names.

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run packages/media-factory/test/plugin.test.ts -t "produces one item for EVERY creator"`
Expected: FAIL — `result.itemsProcessed` is undefined (old return shape has no such field) and/or only one creator's item was produced.

- [ ] **Step 3: Implement the loop**

In `packages/media-factory/src/plugin.ts`, add the import at the top:

```typescript
import { creatorsWithRoom, DAILY_POST_TARGET } from "./throughput";
```

Replace the exact block shown above (lines 118-144) with:

```typescript
        // Give every creator with room under today's target one item per
        // call, instead of always picking the single globally-oldest item —
        // the actual fix for the "1 item/hour system-wide" bottleneck that
        // starved every creator but whichever had the oldest queue entry.
        const eligible = creatorsWithRoom(creators, allContent, DAILY_POST_TARGET);
        const MAX_PER_CALL = 10; // sane upper bound so one call can't run unboundedly long
        const toProcess = eligible.slice(0, MAX_PER_CALL);
        if (toProcess.length === 0) return { skipped: "every creator is caught up or at today's target" };

        const items: Array<{ creator: string; title: string; status: string }> = [];
        for (const creator of toProcess) {
          const next = allContent
            .filter((i) => i.creator_id === creator.id && i.status === "planned" && !i.script)
            .sort((a, b) => (a.id! < b.id! ? -1 : 1))[0];
          if (!next) continue; // room under target, but this creator's queue happens to be empty

          const brief = (next.assets as { brief?: string } | undefined)?.brief ?? "";
          const draft = (await MediaFactoryAgents.produceContentDraft(invoke, creator, next.title, next.hook ?? "", brief, next.platform)) as {
            script?: string;
            caption?: string;
            hashtags?: string[];
            image_prompt?: string;
          };
          const imageAssets = await attachGeneratedImage(creator, next.id!, draft.image_prompt);
          const updated = await MediaFactoryDB.updateContentItemDraft(next.id!, {
            script: draft.script,
            caption: draft.caption,
            hashtags: draft.hashtags,
            assets: imageAssets,
            status: "review",
          });
          await ctx.emit("mediaFactory.produced", { creatorId: creator.id, contentId: next.id });
          items.push({ creator: creator.name, title: next.title, status: updated.status });
        }
        if (items.length === 0) return { skipped: "every eligible creator's queue is empty" };
        return { action: "produced", itemsProcessed: items.length, items };
```

- [ ] **Step 4: Confirm the test passes**

Run: `npx vitest run packages/media-factory/test/plugin.test.ts`
Expected: all tests in the file passing, including the new one.

- [ ] **Step 5: Typecheck and run the full suite**

Run: `npx tsc --noEmit -p tsconfig.json && npx vitest run`
Expected: clean typecheck, all tests passing (should be 407+ from before this plan, plus the new tests from Tasks 1-3).

- [ ] **Step 6: Commit**

```bash
git add packages/media-factory/src/plugin.ts
git commit -m "Fix Media Factory autoCycle to process every creator with room, not one globally"
```

---

### Task 4: Video render job queue — pure data layer

**Files:**
- Create: `packages/publishing/src/video-queue.ts`
- Test: `packages/publishing/test/video-queue.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/publishing/test/video-queue.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { enqueueJob, nextQueuedJob, markDone, markFailed, type VideoRenderJob } from "../src/video-queue";

describe("enqueueJob", () => {
  it("adds a new job with status queued, carrying the render spec directly", () => {
    const spec = { voice: "v", scenes: [{ text: "hi", imageUrl: "http://x/1.jpg" }] };
    const jobs = enqueueJob([], spec);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ spec, status: "queued" });
    expect(jobs[0].id).toBeTruthy();
    expect(jobs[0].requestedAt).toBeTruthy();
  });

  it("keeps existing jobs when adding a new one", () => {
    const existing: VideoRenderJob[] = [{ id: "j1", spec: {}, status: "done", requestedAt: "t", completedAt: "t" }];
    const jobs = enqueueJob(existing, { voice: "v", scenes: [] });
    expect(jobs).toHaveLength(2);
  });
});

describe("nextQueuedJob", () => {
  it("returns the oldest queued job", () => {
    const jobs: VideoRenderJob[] = [
      { id: "j1", spec: {}, status: "queued", requestedAt: "2026-01-01T00:00:02.000Z" },
      { id: "j2", spec: {}, status: "queued", requestedAt: "2026-01-01T00:00:01.000Z" },
      { id: "j3", spec: {}, status: "done", requestedAt: "2026-01-01T00:00:00.000Z", completedAt: "t" },
    ];
    expect(nextQueuedJob(jobs)?.id).toBe("j2");
  });

  it("returns undefined when nothing is queued", () => {
    expect(nextQueuedJob([])).toBeUndefined();
  });

  it("skips a job already marked rendering", () => {
    const jobs: VideoRenderJob[] = [{ id: "j1", spec: {}, status: "rendering", requestedAt: "t" }];
    expect(nextQueuedJob(jobs)).toBeUndefined();
  });
});

describe("markDone / markFailed", () => {
  it("updates the matching job to done with a result path", () => {
    const jobs: VideoRenderJob[] = [{ id: "j1", spec: {}, status: "rendering", requestedAt: "t" }];
    const updated = markDone(jobs, "j1", "/path/to/video.mp4");
    expect(updated[0]).toMatchObject({ status: "done", resultPath: "/path/to/video.mp4" });
    expect(updated[0].completedAt).toBeTruthy();
  });

  it("updates the matching job to failed with an error message", () => {
    const jobs: VideoRenderJob[] = [{ id: "j1", spec: {}, status: "rendering", requestedAt: "t" }];
    const updated = markFailed(jobs, "j1", "ffmpeg exited 1");
    expect(updated[0]).toMatchObject({ status: "failed", error: "ffmpeg exited 1" });
  });

  it("leaves other jobs untouched", () => {
    const jobs: VideoRenderJob[] = [
      { id: "j1", spec: {}, status: "rendering", requestedAt: "t" },
      { id: "j2", spec: {}, status: "queued", requestedAt: "t" },
    ];
    const updated = markDone(jobs, "j1", "/x.mp4");
    expect(updated[1]).toEqual(jobs[1]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run packages/publishing/test/video-queue.test.ts`
Expected: FAIL — module `../src/video-queue` doesn't exist.

- [ ] **Step 3: Implement**

Create `packages/publishing/src/video-queue.ts`:

```typescript
import { randomUUID } from "node:crypto";

export interface VideoRenderJob {
  id: string;
  /** The exact render spec MontageRenderer.render() expects — carried
   * directly on the job (not a foreign-key lookup) since the source reel
   * only ever exists in-memory during the orchestrator's cycle, with
   * nothing durable to look it back up from later. */
  spec: unknown;
  status: "queued" | "rendering" | "done" | "failed";
  requestedAt: string;
  completedAt?: string;
  resultPath?: string;
  error?: string;
}

/** Add a new queued job carrying the given render spec. Pure — caller
 * persists the returned array (same load/mutate/save pattern as
 * automation.json). */
export function enqueueJob(jobs: VideoRenderJob[], spec: unknown): VideoRenderJob[] {
  return [...jobs, { id: randomUUID(), spec, status: "queued", requestedAt: new Date().toISOString() }];
}

/** The oldest job still waiting to be rendered, or undefined if none —
 * "rendering"/"done"/"failed" jobs are never returned (one at a time). */
export function nextQueuedJob(jobs: VideoRenderJob[]): VideoRenderJob | undefined {
  return jobs
    .filter((j) => j.status === "queued")
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))[0];
}

export function markDone(jobs: VideoRenderJob[], id: string, resultPath: string): VideoRenderJob[] {
  return jobs.map((j) => (j.id === id ? { ...j, status: "done" as const, resultPath, completedAt: new Date().toISOString() } : j));
}

export function markFailed(jobs: VideoRenderJob[], id: string, error: string): VideoRenderJob[] {
  return jobs.map((j) => (j.id === id ? { ...j, status: "failed" as const, error, completedAt: new Date().toISOString() } : j));
}
```

- [ ] **Step 4: Confirm it passes**

Run: `npx vitest run packages/publishing/test/video-queue.test.ts`
Expected: 7 tests passing.

- [ ] **Step 5: Commit**

```bash
git add packages/publishing/src/video-queue.ts packages/publishing/test/video-queue.test.ts
git commit -m "Add pure video-render job queue data layer"
```

---

### Task 5: Wire the job queue into ATLAS's own daily-Reel render path (enqueue instead of inline render)

This fixes the 30-second inline timeout for the one video render that exists today (the orchestrator's daily Reel for ATLAS's own persona) and builds the reusable job-queue infrastructure. It does not yet touch Media Factory's per-creator content — that's real follow-up work, described at the end of this plan.

**Files:**
- Modify: `packages/orchestrator/src/plugin.ts` (the inline video-render block, lines ~93-109 — see the exact current code below)
- Test: `packages/orchestrator/test/plugin.test.ts` (existing — add to it)

Current code being replaced (from the file read earlier in this session):

```typescript
        let videoRef = cmd.videoRef ?? null;
        if (!videoRef) {
          try {
            console.log(`[orchestrator] Rendering video for topic: ${topic}`);
            const renderResult = (await Promise.race([
              ctx.call("publishing", { op: "render", spec: reel }),
              new Promise((_, reject) => setTimeout(() => reject(new Error("render timed out after 30s")), 30_000)),
            ])) as { videoPath: string };
            videoRef = renderResult.videoPath || null;
          } catch (err) {
            console.error("[orchestrator] Video rendering failed or timed out, proceeding without videoRef:", err);
          }
        }
```

- [ ] **Step 1: Write the failing test**

Find the existing daily-cycle test in `packages/orchestrator/test/plugin.test.ts` (search `grep -n "videoRef\|render" packages/orchestrator/test/plugin.test.ts`) and add a test asserting the cycle no longer blocks on rendering:

```typescript
it("enqueues a video render job instead of rendering inline, and doesn't block on it", async () => {
  let enqueueCalled = false;
  const ctx = fakeContext({
    services: {
      publishing: async (payload: any) => {
        if (payload.op === "enqueueRender") {
          enqueueCalled = true;
          return { jobId: "j1" };
        }
        throw new Error(`unexpected publishing op in test: ${payload.op}`);
      },
    },
  });
  const plugin = createOrchestratorPlugin({ healEnabled: false });
  plugin.register(ctx);

  const start = Date.now();
  await ctx.invoke("orchestrator", { op: "runDailyCycle" });
  const elapsedMs = Date.now() - start;

  expect(enqueueCalled).toBe(true);
  expect(elapsedMs).toBeLessThan(5000); // no 30s render wait in the critical path
});
```

Match this to whatever `fakeContext`/`createOrchestratorPlugin` fixture shape the existing tests in this file already use — read the top of `plugin.test.ts` first.

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run packages/orchestrator/test/plugin.test.ts -t "enqueues a video render job"`
Expected: FAIL — `enqueueCalled` is false, or the test throws on an unexpected `op: "render"` call.

- [ ] **Step 3: Implement**

In `packages/orchestrator/src/plugin.ts`, replace the block shown above with:

```typescript
        let videoRef = cmd.videoRef ?? null;
        if (!videoRef) {
          try {
            const { jobId } = (await ctx.call("publishing", { op: "enqueueRender", spec: reel })) as { jobId: string };
            console.log(`[orchestrator] Video render job ${jobId} queued for topic: ${topic} (renders in the background, doesn't block this cycle)`);
          } catch (err) {
            console.error("[orchestrator] Failed to queue video render:", err);
          }
        }
```

Note `videoRef` stays `null` for this cycle's report — publishing picks up the finished video once the background job completes (Task 6), not synchronously here.

- [ ] **Step 4: Add the `enqueueRender` op to the publishing plugin**

Find the publishing plugin's `ctx.provide("publishing", ...)` handler:

Run: `grep -n 'ctx.provide("publishing"' packages/publishing/src/plugin.ts`

Add a new branch alongside the existing `op === "render"` handling:

```typescript
        if (cmd.op === "enqueueRender") {
          const raw = await readFile(videoJobsPath, "utf8").catch(() => "[]");
          const jobs = JSON.parse(raw) as VideoRenderJob[];
          const updated = enqueueJob(jobs, cmd.spec);
          await writeFile(videoJobsPath, JSON.stringify(updated), "utf8");
          const job = updated[updated.length - 1]!;
          return { jobId: job.id };
        }
```

At the top of `packages/publishing/src/plugin.ts`, add:

```typescript
import { readFile, writeFile } from "node:fs/promises";
import { enqueueJob, type VideoRenderJob } from "./video-queue";
```

And near wherever this plugin's other file paths are defined (or, if none exist yet, right before the `ctx.provide("publishing", ...)` call), add:

```typescript
      const videoJobsPath = `${opts.dataDir ?? "data"}/video-jobs.json`;
```

Check `createPublishingPlugin`'s options parameter (`grep -n "createPublishingPlugin" packages/publishing/src/plugin.ts`) — if it doesn't currently accept a `dataDir` option, add one (default `"data"`, matching every other plugin's convention of taking `dataDir` from `AtlasOptions`).

- [ ] **Step 5: Confirm the test passes**

Run: `npx vitest run packages/orchestrator/test/plugin.test.ts`
Expected: all tests passing, including the new one.

- [ ] **Step 6: Typecheck and run the full suite**

Run: `npx tsc --noEmit -p tsconfig.json && npx vitest run`
Expected: clean typecheck, all tests passing.

- [ ] **Step 7: Commit**

```bash
git add packages/orchestrator/src/plugin.ts packages/publishing/src/plugin.ts
git commit -m "Orchestrator enqueues video renders instead of blocking the cycle on them"
```

---

### Task 6: Background worker that actually processes the queue

**Files:**
- Modify: `packages/server/src/server.ts` (add a new interval, same pattern as the automation/brief schedulers already in this file)

- [ ] **Step 1: Add load/save helpers and the worker function**

In `packages/server/src/server.ts`, near the other state-file declarations (`automationStateFile`, `urgentAlertStateFile`), add:

```typescript
  const videoJobsFile = `${dataDir}/video-jobs.json`;
```

Near `checkUrgentFindings` (same closure scope, has access to `ensureAtlas`/`vault`), add:

```typescript
  /** Picks up ONE queued video-render job every 2 minutes, independent of
   * the hourly business cycle so a slow render (which can legitimately take
   * minutes: TTS + image fetch + ffmpeg) never blocks anything else, and a
   * cycle never again has to guess-and-timeout at 30s. */
  async function processOneVideoJob(): Promise<void> {
    if (!vault.unlocked) return;
    try {
      const raw = await readFile(videoJobsFile, "utf8").catch(() => "[]");
      const jobs = JSON.parse(raw) as import("@atlas/publishing").VideoRenderJob[];
      const { nextQueuedJob, markDone, markFailed } = await import("@atlas/publishing");
      const job = nextQueuedJob(jobs);
      if (!job) return;

      const rendering = jobs.map((j) => (j.id === job.id ? { ...j, status: "rendering" as const } : j));
      await writeFile(videoJobsFile, JSON.stringify(rendering), "utf8");

      const a = await ensureAtlas();
      try {
        const result = (await Promise.race([
          a.invoke("publishing", { op: "renderQueuedJob", spec: job.spec }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("render exceeded 5 minute safety bound")), 5 * 60_000)),
        ])) as { videoPath: string };
        await writeFile(videoJobsFile, JSON.stringify(markDone(rendering, job.id, result.videoPath)), "utf8");
        console.log(`[VIDEO QUEUE] Job ${job.id} rendered: ${result.videoPath}`);
      } catch (err) {
        await writeFile(videoJobsFile, JSON.stringify(markFailed(rendering, job.id, (err as Error).message)), "utf8");
        console.error(`[VIDEO QUEUE] Job ${job.id} failed:`, (err as Error).message);
      }
    } catch (err) {
      console.error("[VIDEO QUEUE] worker tick failed:", (err as Error).message);
    }
  }

  setInterval(() => void processOneVideoJob(), 2 * 60 * 1000);
```

- [ ] **Step 2: Add the `renderQueuedJob` op to the publishing plugin**

In `packages/publishing/src/plugin.ts`, alongside the existing `op === "render"` handler, add:

```typescript
        if (cmd.op === "renderQueuedJob") {
          const videoPath = await renderer.render(cmd.spec as Parameters<typeof renderer.render>[0]);
          return { videoPath };
        }
```

This is deliberately almost identical to the existing `op === "render"` handler two lines above it (`const videoPath = await renderer.render(cmd.spec); return { videoPath };`) — the queued path renders the exact same spec shape, just picked up later by the background worker instead of inline. No spec reconstruction needed since the full spec was captured at enqueue time (Task 4/5).

- [ ] **Step 3: Export `VideoRenderJob` and the queue functions from the publishing package**

Check `packages/publishing/src/index.ts`:

Run: `cat packages/publishing/src/index.ts`

Add if not already present:

```typescript
export * from "./video-queue";
```

- [ ] **Step 4: Typecheck and run the full suite**

Run: `npx tsc --noEmit -p tsconfig.json && npx vitest run`
Expected: clean typecheck, all tests passing.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/server.ts packages/publishing/src/plugin.ts packages/publishing/src/index.ts
git commit -m "Background worker renders queued video jobs every 2 minutes, independent of the hourly cycle"
```

---

### Task 7: Deploy and verify on the real VPS

**Files:** none (deploy-only task)

- [ ] **Step 1: Push to GitHub**

```bash
git push origin main
```

- [ ] **Step 2: Copy every changed file to the VPS**

```bash
scp -i ~/.ssh/atlas_deploy packages/media-factory/src/db.ts packages/media-factory/src/throughput.ts packages/media-factory/src/plugin.ts root@72.62.168.207:/opt/atlas/app/packages/media-factory/src/
scp -i ~/.ssh/atlas_deploy packages/publishing/src/video-queue.ts packages/publishing/src/plugin.ts packages/publishing/src/index.ts root@72.62.168.207:/opt/atlas/app/packages/publishing/src/
scp -i ~/.ssh/atlas_deploy packages/orchestrator/src/plugin.ts root@72.62.168.207:/opt/atlas/app/packages/orchestrator/src/
scp -i ~/.ssh/atlas_deploy packages/server/src/server.ts root@72.62.168.207:/opt/atlas/app/packages/server/src/
```

- [ ] **Step 3: Restart and confirm healthy boot**

```bash
ssh -i ~/.ssh/atlas_deploy root@72.62.168.207 "docker restart atlas && sleep 8 && curl -s -o /dev/null -w '%{http_code}\n' localhost:4317/api/health && docker logs atlas --tail 20"
```

Expected: `200`, clean startup log, no new errors.

- [ ] **Step 4: Force a cycle and confirm multi-creator throughput for real**

```bash
ssh -i ~/.ssh/atlas_deploy root@72.62.168.207 '
i=0
while [ $i -lt 24 ]; do
  if docker logs atlas --since 3m 2>&1 | grep -q "Automated hourly cycle complete"; then echo CYCLE_DONE; break; fi
  sleep 5; i=$((i+1))
done
docker logs atlas --since 3m 2>&1 | grep -iE "mediaFactory.scripted|VIDEO QUEUE|drawtext|render timed out"
'
```

Expected: evidence of `itemsProcessed` greater than 1 if more than one creator had room (only 1 real creator exists today, so this will show `itemsProcessed: 1` until more creators are added — that's correct, not a failure of the fix), a `[VIDEO QUEUE]` line within ~2 minutes if a job was queued, and no `render timed out` or `drawtext` errors.

- [ ] **Step 5: Report back**

Confirm to Mat: deployed, verified live, throughput fix + async video queue both holding under a real forced cycle.

---

## Next

**Real gap this plan does not close, found while verifying the actual code:** Media Factory's per-creator content pipeline (`produceContentDraft`) outputs one script blob + one image per item — there's no per-scene breakdown, so there's nothing yet to feed `MontageRenderer` (which needs `{ voice, scenes: [{ text, imageUrl }] }`). Wiring real video into the 10-creator pipeline needs `produceContentDraft`'s output reshaped into multiple scenes first — a real design decision (how many scenes per video, how scene text splits from the script) that deserves its own short brainstorming pass rather than being bolted onto this plan as an afterthought. Do that as a follow-up plan once this one is deployed and verified, reusing the `enqueueJob`/`video-queue.ts` infrastructure built here.

Plan 2 (account connection + posting pipeline) and Plan 3 (comment/DM auto-reply) also follow this one — both depend on content flowing reliably, which this plan fixes for images today and unblocks for video once the follow-up above lands.
