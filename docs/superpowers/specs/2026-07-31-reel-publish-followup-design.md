# Reel Publish Follow-Up — Design

**Status:** Approved by Mat 2026-07-31.

## Problem

Confirmed live on the VPS: `approvals.json` contains 63 approval decisions in this system's entire history, and every single one is a "Worth a look" GitHub-install proposal from autonomous repo scouting. Zero are "Post Reel to Instagram." This isn't neglect — it's structural. The orchestrator's daily cycle (`packages/orchestrator/src/plugin.ts`) enqueues a video render (`ctx.call("publishing", {op:"enqueueRender", spec: reel})`, async, can take real minutes) and then, in the *same* cycle, calls `publishing.publish()` with `videoRef` still `null`. `publish()`'s own logic only requests a human approval once `videoRef` is set — with it null, `publish()` always short-circuits to `{status:"pending-render"}` and the approval-request branch is never reached. Nothing ever revisits the reel once its render actually finishes. The 2-minute worker tick in `packages/server/src/server.ts` (`processOneVideoJob`) marks the job `"done"` with a `resultPath` and stops there — it never calls `publish()` again.

Net effect: combined with the render pipeline being 100%-broken until earlier today's ffmpeg fix, ATLAS's content business has never once had a real chance to post anything. The only thing flowing end-to-end through the approval system is zero-revenue GitHub tool-install noise.

## Scope

**In scope:** carrying enough information on a video-render job for a completed *orchestrator-originated Reel* to trigger a real `publish()` call (and therefore a real approval request) once its render finishes, with no change to the daily cycle's own timing/blocking behavior.

**Out of scope:** Media Factory's own video jobs (`contentId` set) — those already have a working manual "Send for Approval" flow built earlier this session and are untouched by this change. Also out of scope: retroactively publishing any Reel that finished rendering before this fix ships (see Known Limitations) — not worth a backfill script for what's at most a handful of jobs.

## Architecture

**`packages/publishing/src/video-queue.ts`:**
- `VideoRenderJob` gains an optional field: `publishInput?: Omit<PublishInput, "videoRef">` — everything `publish()` needs except the video path, which only exists once the render is done.
- `enqueueJob(jobs, spec, contentId?, publishInput?)` gains the new optional parameter and stores it on the created job.
- New pure, directly-testable function:
  ```ts
  export async function requestPublishForFinishedJob(
    job: VideoRenderJob,
    callPublish: (input: PublishInput) => Promise<unknown>,
  ): Promise<unknown | undefined> {
    if (job.status !== "done" || !job.resultPath || !job.publishInput) return undefined;
    return callPublish({ ...job.publishInput, videoRef: job.resultPath });
  }
  ```
  This is the whole fix's actual logic, isolated from the real worker tick's timing/IO so it can be unit-tested with a fake `callPublish` instead of waiting on a real 2-minute interval.

**`packages/publishing/src/types.ts`:** `PublishCommand`'s `enqueueRender` variant gains an optional `publishInput?: Omit<PublishInput, "videoRef">`, passed through to `enqueueJob` in `plugin.ts`.

**`packages/orchestrator/src/plugin.ts`:** the existing `enqueueRender` call gains `publishInput`, built by stripping `videoRef` off the already-existing `reelToPublishInput(reel, null)` call. No change to the same-cycle `publish()` call right after — it still runs and still (accurately) reports `pending-render` for that cycle's own health/report, since the render genuinely isn't done yet at that point.

**`packages/server/src/server.ts`'s `processOneVideoJob()`:** right after a successful `markDone`, call `requestPublishForFinishedJob(job, (input) => a.invoke("publishing", {op:"publish", input}))`. This is the one new line that closes the loop. Media Factory jobs simply have no `publishInput`, so the function is a guaranteed no-op for them — no branching needed to distinguish job types.

## Error handling

If `publish()` rejects the reel (e.g., a caption that fails Instagram validation), that's logged clearly via `console.error` in the same style as the tick's existing failure logging — the rendered mp4 file is never touched or deleted, so nothing is unrecoverable, it just doesn't reach Mat's Approvals tab automatically. If the `callPublish` call itself throws (e.g. approvals service unavailable), same handling: caught, logged, the job stays `"done"` with its `resultPath` intact.

## Testing

- `packages/publishing/test/plugin.test.ts` (or a new `video-queue.test.ts` if that's cleaner — follow whichever pattern the implementer finds already covers `enqueueJob`/`markDone`): unit tests for `requestPublishForFinishedJob` — done job with `publishInput` calls `callPublish` once with `{...publishInput, videoRef: resultPath}`; job without `publishInput` (Media Factory shape) never calls it; job that's `queued`/`rendering`/`failed` never calls it.
- Extend the existing `enqueueRender` test to confirm a passed `publishInput` is persisted onto the written job record.
- `packages/orchestrator/test/*.test.ts`: confirm the daily cycle's `enqueueRender` call now includes a `publishInput` matching `reelToPublishInput`'s fields (minus `videoRef`).
- No integration test for `processOneVideoJob` itself — it's a private closure driven by a real 2-minute interval with no existing test coverage at all (confirmed before writing this spec) and stays out of scope for this fix. Wiring correctness is verified live instead: after deploy, trigger a cycle, wait for a real render to complete, and confirm a real "Post Reel" approval appears in the live `approvals.json` — the same verification method already used for this session's ffmpeg fix and the social-permission fix.

## Known limitations

1. Any Reel that already finished rendering between today's ffmpeg fix and this fix going live won't retroactively get a publish request — its job record predates the `publishInput` field. Not worth a backfill script for what's at most a handful of jobs; every render from this point forward is covered.
2. If `publish()` is rejected or errors, the only visibility is the server log — there's no surfacing of "a Reel finished but couldn't be auto-submitted" in the Brief or UI. Given this is expected to be rare (most rejections would mean the reel-writing prompt itself needs tuning, not a recoverable runtime state), that's left as a future improvement rather than in scope here.
