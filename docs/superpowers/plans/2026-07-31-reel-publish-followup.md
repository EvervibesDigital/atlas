# Reel Publish Follow-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an orchestrator-originated Reel's async video render finishes, actually request Mat's approval to post it — closing a gap where zero "Post Reel" approvals have ever existed in production.

**Architecture:** A render job optionally carries everything `publishing.publish()` needs (minus the video path, which only exists once rendering is done). A new pure function checks a finished job for that data and calls publish with it. The server's existing 2-minute worker tick calls this function right after marking a job done.

**Tech Stack:** TypeScript, Vitest, the existing `@atlas/publishing` job-queue pattern.

**Design doc:** `docs/superpowers/specs/2026-07-31-reel-publish-followup-design.md`

---

### Task 1: `VideoRenderJob` carries `publishInput`; new `requestPublishForFinishedJob`

**Files:**
- Modify: `packages/publishing/src/video-queue.ts`
- Test: `packages/publishing/test/video-queue.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/publishing/test/video-queue.test.ts`, inside the existing `describe("enqueueJob", ...)` block (after the last existing `it`, before its closing `});`):

```typescript
  it("carries an optional publishInput through, when the caller provides one", () => {
    const publishInput = { personaHandle: "@handle", caption: "hi", hashtags: ["#a"], width: 1080, height: 1920, durationSec: 12 };
    const jobs = enqueueJob([], { voice: "v", scenes: [] }, undefined, publishInput);
    expect(jobs[0]!.publishInput).toEqual(publishInput);
  });

  it("leaves publishInput undefined when the caller doesn't provide one", () => {
    const jobs = enqueueJob([], { voice: "v", scenes: [] });
    expect(jobs[0]!.publishInput).toBeUndefined();
  });
```

Add a new `describe` block at the end of the file (after the existing `describe("markDone / markFailed", ...)` block's closing `});`):

```typescript
describe("requestPublishForFinishedJob", () => {
  it("calls publish with the job's publishInput plus the finished video's resultPath", async () => {
    const publishInput = { personaHandle: "@handle", caption: "hi", hashtags: ["#a"], width: 1080, height: 1920, durationSec: 12 };
    const job: VideoRenderJob = { id: "j1", spec: {}, status: "done", requestedAt: "t", completedAt: "t", resultPath: "/x.mp4", publishInput };
    const calls: unknown[] = [];
    const callPublish = async (input: unknown) => { calls.push(input); return { status: "pending-approval" }; };

    const result = await requestPublishForFinishedJob(job, callPublish);

    expect(calls).toEqual([{ ...publishInput, videoRef: "/x.mp4" }]);
    expect(result).toEqual({ status: "pending-approval" });
  });

  it("does nothing when the job has no publishInput (e.g. a Media Factory job)", async () => {
    const job: VideoRenderJob = { id: "j1", spec: {}, status: "done", requestedAt: "t", completedAt: "t", resultPath: "/x.mp4", contentId: "c1" };
    const calls: unknown[] = [];
    const callPublish = async (input: unknown) => { calls.push(input); return {}; };

    const result = await requestPublishForFinishedJob(job, callPublish);

    expect(calls).toHaveLength(0);
    expect(result).toBeUndefined();
  });

  it("does nothing when the job isn't done yet", async () => {
    const publishInput = { personaHandle: "@handle", caption: "hi", hashtags: [], width: 1080, height: 1920, durationSec: 12 };
    const job: VideoRenderJob = { id: "j1", spec: {}, status: "rendering", requestedAt: "t", publishInput };
    const calls: unknown[] = [];
    const callPublish = async (input: unknown) => { calls.push(input); return {}; };

    const result = await requestPublishForFinishedJob(job, callPublish);

    expect(calls).toHaveLength(0);
    expect(result).toBeUndefined();
  });
});
```

Update the file's top import line from:

```typescript
import { enqueueJob, nextQueuedJob, markDone, markFailed, type VideoRenderJob } from "../src/video-queue";
```

to:

```typescript
import { enqueueJob, nextQueuedJob, markDone, markFailed, requestPublishForFinishedJob, type VideoRenderJob } from "../src/video-queue";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- packages/publishing/test/video-queue.test.ts`
Expected: FAIL — `requestPublishForFinishedJob` is not exported / `publishInput` doesn't exist on the type (TypeScript/import error), plus the two new `enqueueJob` assertions failing since `publishInput` isn't stored yet.

- [ ] **Step 3: Implement**

In `packages/publishing/src/video-queue.ts`, the current file looks like this:

```typescript
import { randomUUID } from "node:crypto";

export interface VideoRenderJob {
  id: string;
  spec: unknown;
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

Change it to:

```typescript
import { randomUUID } from "node:crypto";
import type { PublishInput } from "./types";

export interface VideoRenderJob {
  id: string;
  spec: unknown;
  contentId?: string;
  /** Set when the caller wants the finished render auto-submitted for
   * publish approval (the orchestrator's own daily Reel) — everything
   * publish() needs except videoRef, which only exists once the job is
   * done. Media Factory's own video jobs never set this; they go through
   * their own manual "Send for Approval" UI flow instead. */
  publishInput?: Omit<PublishInput, "videoRef">;
  status: "queued" | "rendering" | "done" | "failed";
  requestedAt: string;
  completedAt?: string;
  resultPath?: string;
  error?: string;
}

export function enqueueJob(jobs: VideoRenderJob[], spec: unknown, contentId?: string, publishInput?: Omit<PublishInput, "videoRef">): VideoRenderJob[] {
  return [...jobs, { id: randomUUID(), spec, contentId, publishInput, status: "queued", requestedAt: new Date().toISOString() }];
}
```

Add this new function at the end of the file (after `markFailed`):

```typescript
/** If a finished job carries publishInput, actually requests approval to
 * publish it now that a real videoRef exists — this is the one thing that
 * closes the loop from "render done" back to a human ever seeing it. A job
 * with no publishInput (Media Factory's own video jobs) or one that isn't
 * done yet is a guaranteed no-op, so callers never need to branch on job
 * type themselves. */
export async function requestPublishForFinishedJob(
  job: VideoRenderJob,
  callPublish: (input: PublishInput) => Promise<unknown>,
): Promise<unknown | undefined> {
  if (job.status !== "done" || !job.resultPath || !job.publishInput) return undefined;
  return callPublish({ ...job.publishInput, videoRef: job.resultPath });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- packages/publishing/test/video-queue.test.ts`
Expected: PASS (all tests in the file, including the 5 new ones)

- [ ] **Step 5: Commit**

```bash
git add packages/publishing/src/video-queue.ts packages/publishing/test/video-queue.test.ts
git commit -m "feat(publishing): add requestPublishForFinishedJob and publishInput on video jobs"
```

---

### Task 2: Wire `publishInput` through `PublishCommand` and the `enqueueRender` op

**Files:**
- Modify: `packages/publishing/src/types.ts`
- Modify: `packages/publishing/src/plugin.ts`
- Test: `packages/publishing/test/plugin.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/publishing/test/plugin.test.ts`, right after the existing `"enqueueRender queues a job with the given spec and persists it to disk"` test (inside the same `describe` block):

```typescript
  it("enqueueRender persists an optional publishInput onto the job", async () => {
    const atlas = new Atlas({ guardian: permissiveGuardian() });
    await atlas.use(createPublishingPlugin({ renderer: fakeRenderer("x.mp4"), videoJobsFile }));

    const spec = { voice: "v1", scenes: [{ text: "hi", imageUrl: "http://x/1.jpg" }] };
    const publishInput = { personaHandle: "@handle", caption: "hi", hashtags: ["#a"], width: 1080, height: 1920, durationSec: 12 };
    await atlas.invoke("publishing", { op: "enqueueRender", spec, publishInput });

    const raw = await readFile(videoJobsFile, "utf8");
    const jobs = JSON.parse(raw) as VideoRenderJob[];
    expect(jobs[0]!.publishInput).toEqual(publishInput);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/publishing/test/plugin.test.ts -t "persists an optional publishInput"`
Expected: FAIL — `publishInput` is `undefined` on the written job (the op doesn't accept/pass it yet), or a TypeScript error if `enqueueRender`'s command type doesn't have the field.

- [ ] **Step 3: Implement**

In `packages/publishing/src/types.ts`, change:

```typescript
  | { op: "enqueueRender"; spec: { voice: string; scenes: Array<{ text: string; imageUrl: string }> }; contentId?: string }
```

to:

```typescript
  | { op: "enqueueRender"; spec: { voice: string; scenes: Array<{ text: string; imageUrl: string }> }; contentId?: string; publishInput?: Omit<PublishInput, "videoRef"> }
```

In `packages/publishing/src/plugin.ts`, change the `enqueueRender` handler from:

```typescript
        if (cmd.op === "enqueueRender") {
          const raw = await readFile(videoJobsPath, "utf8").catch(() => "[]");
          const existing = JSON.parse(raw) as VideoRenderJob[];
          const updated = enqueueJob(existing, cmd.spec, cmd.contentId);
          await writeFile(videoJobsPath, JSON.stringify(updated), "utf8");
          const job = updated[updated.length - 1]!;
          return { jobId: job.id };
        }
```

to:

```typescript
        if (cmd.op === "enqueueRender") {
          const raw = await readFile(videoJobsPath, "utf8").catch(() => "[]");
          const existing = JSON.parse(raw) as VideoRenderJob[];
          const updated = enqueueJob(existing, cmd.spec, cmd.contentId, cmd.publishInput);
          await writeFile(videoJobsPath, JSON.stringify(updated), "utf8");
          const job = updated[updated.length - 1]!;
          return { jobId: job.id };
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/publishing/test/plugin.test.ts`
Expected: PASS (all tests in the file, including the new one)

- [ ] **Step 5: Commit**

```bash
git add packages/publishing/src/types.ts packages/publishing/src/plugin.ts packages/publishing/test/plugin.test.ts
git commit -m "feat(publishing): accept publishInput on the enqueueRender op"
```

---

### Task 3: Orchestrator passes `publishInput` when enqueueing a Reel's render

**Files:**
- Modify: `packages/orchestrator/src/plugin.ts`
- Test: `packages/app/test/cycle.test.ts`

- [ ] **Step 1: Write the failing test**

Add this new test to `packages/app/test/cycle.test.ts`, inside the existing `describe("autonomous daily cycle", ...)` block (after the first test, `"drafts a Reel, consults the council, and produces a morning report"`):

```typescript
  it("enqueues the Reel's render with a publishInput, so a finished render can request approval later", async () => {
    const { mkdtemp, rm, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "atlas-cycle-test-"));
    const videoJobsFile = join(dir, "video-jobs.json");

    try {
      await runDailyCycle({
        memoryStore: new InMemoryStore(),
        approvalsGateway: new ApprovalGateway(),
        metricsTracker: new MetricsTracker(),
        brainAdapters: [new StubAdapter()],
        renderer: new NoOpRenderer(),
        videoJobsFile,
        healEnabled: false,
      });

      const raw = await readFile(videoJobsFile, "utf8");
      const jobs = JSON.parse(raw) as Array<{ publishInput?: { personaHandle?: string; caption?: string } }>;
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.publishInput).toBeTruthy();
      expect(jobs[0]!.publishInput!.personaHandle).toBeTruthy();
      expect(jobs[0]!.publishInput!.caption).toBeTruthy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/app/test/cycle.test.ts -t "publishInput"`
Expected: FAIL — `jobs[0].publishInput` is `undefined` (the orchestrator doesn't pass it yet).

- [ ] **Step 3: Implement**

In `packages/orchestrator/src/plugin.ts`, the current code around the render-enqueue step reads:

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

Change it to:

```typescript
        let videoRef = cmd.videoRef ?? null;
        if (!videoRef) {
          try {
            const { videoRef: _drop, ...publishInputBase } = reelToPublishInput(reel, null);
            const { jobId } = (await ctx.call("publishing", { op: "enqueueRender", spec: reel, publishInput: publishInputBase })) as { jobId: string };
            console.log(`[orchestrator] Video render job ${jobId} queued for topic: ${topic} (renders in the background, doesn't block this cycle) — will request publish approval once the render finishes`);
          } catch (err) {
            console.error("[orchestrator] Failed to queue video render:", err);
          }
        }
```

`reelToPublishInput` is already imported in this file (it's used two steps later for the same-cycle `publish` call) — confirm the import line already includes it; if not, add it to the existing `import { ..., reelToPublishInput } from "./core"` line.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/app/test/cycle.test.ts`
Expected: PASS (all tests in the file, including the new one). Note: this test suite can take up to ~35s per the file's existing timeout comments — that's normal, not a hang.

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/plugin.ts packages/app/test/cycle.test.ts
git commit -m "feat(orchestrator): pass publishInput when enqueueing a Reel's render"
```

---

### Task 4: Server's worker tick requests publish once a job finishes; full verification + deploy

**Files:**
- Modify: `packages/server/src/server.ts`
- No new test (see Testing section of the design doc — `processOneVideoJob` has zero existing test coverage and stays untested at the integration level; wiring is verified live below)

- [ ] **Step 1: Implement**

In `packages/server/src/server.ts`, the current `processOneVideoJob` function reads:

```typescript
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
```

Change it to (the only change is the `try` block after a successful render — everything else is untouched):

```typescript
  async function processOneVideoJob(): Promise<void> {
    if (!vault.unlocked) return;
    try {
      const raw = await readFile(videoJobsFile, "utf8").catch(() => "[]");
      const jobs = JSON.parse(raw) as import("@atlas/publishing").VideoRenderJob[];
      const { nextQueuedJob, markDone, markFailed, requestPublishForFinishedJob } = await import("@atlas/publishing");
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
        const done = markDone(rendering, job.id, result.videoPath);
        await writeFile(videoJobsFile, JSON.stringify(done), "utf8");
        console.log(`[VIDEO QUEUE] Job ${job.id} rendered: ${result.videoPath}`);

        const finishedJob = done.find((j) => j.id === job.id)!;
        try {
          const publishResult = await requestPublishForFinishedJob(finishedJob, (input) => a.invoke("publishing", { op: "publish", input }));
          if (publishResult) console.log(`[VIDEO QUEUE] Job ${job.id} requested publish approval:`, JSON.stringify(publishResult));
        } catch (err) {
          console.error(`[VIDEO QUEUE] Job ${job.id} finished but auto-publish-request failed:`, (err as Error).message);
        }
      } catch (err) {
        await writeFile(videoJobsFile, JSON.stringify(markFailed(rendering, job.id, (err as Error).message)), "utf8");
        console.error(`[VIDEO QUEUE] Job ${job.id} failed:`, (err as Error).message);
      }
    } catch (err) {
      console.error("[VIDEO QUEUE] worker tick failed:", (err as Error).message);
    }
  }
```

- [ ] **Step 2: Run the full workspace test suite**

Run: `pnpm test`
Expected: all tests pass (no regressions in any package). If `packages/codebase/test/healer.test.ts` fails with `EBUSY` errors, that's known pre-existing Windows temp-dir flakiness under full-suite CPU contention (confirmed unrelated to this change earlier this session) — re-run that one file alone (`pnpm test -- packages/codebase/test/healer.test.ts`) to confirm, don't treat it as a regression from this work.

- [ ] **Step 3: Run the full workspace typecheck**

Run: `pnpm typecheck`
Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/server.ts
git commit -m "feat(server): request publish approval once a Reel's render job finishes"
```

- [ ] **Step 5: Push and deploy**

```bash
git push origin main
```

```bash
scp -i ~/.ssh/atlas_deploy packages/publishing/src/video-queue.ts packages/publishing/src/types.ts packages/publishing/src/plugin.ts root@72.62.168.207:/opt/atlas/app/packages/publishing/src/
scp -i ~/.ssh/atlas_deploy packages/orchestrator/src/plugin.ts root@72.62.168.207:/opt/atlas/app/packages/orchestrator/src/
scp -i ~/.ssh/atlas_deploy packages/server/src/server.ts root@72.62.168.207:/opt/atlas/app/packages/server/src/
ssh -i ~/.ssh/atlas_deploy root@72.62.168.207 "docker restart atlas && sleep 15 && curl -s -o /dev/null -w '%{http_code}' http://localhost:4317/api/health"
```

Expected: `200`. (Note: the control panel listens on port 4317, not 3000 — confirmed earlier this session.)

- [ ] **Step 6: Verify live — confirm a real approval gets created**

This is the actual proof the fix works, matching how the ffmpeg render bug and the social-permission bug were both verified live this session (an automated test can't cover the real 2-minute worker tick).

```bash
ssh -i ~/.ssh/atlas_deploy root@72.62.168.207 "docker logs atlas --tail 50 | grep -E 'Video render job|requested publish approval|VIDEO QUEUE'"
```

Wait for a cycle to run and a render to complete (renders have taken low-single-digit minutes in this session's earlier live verification; the worker tick runs every 2 minutes). Expected: a log line reading `[VIDEO QUEUE] Job <id> requested publish approval: {"status":"pending-approval",...}` following a `[VIDEO QUEUE] Job <id> rendered: ...` line for the same job id.

Then confirm it actually landed in the approval queue:

```bash
ssh -i ~/.ssh/atlas_deploy root@72.62.168.207 "cd /opt/atlas/app && node -e \"const a = JSON.parse(require('fs').readFileSync('data/approvals.json','utf8')); console.log(a.filter(x => x.action.includes('Post Reel')).slice(-3));\""
```

Expected: at least one approval entry with `action` containing `"Post Reel to Instagram"` and a recent `createdAt` timestamp — the first one in this system's entire history.
