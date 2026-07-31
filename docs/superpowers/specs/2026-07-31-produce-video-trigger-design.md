# Media Factory "Produce Video" Trigger — Design

**Status:** Approved by Mat 2026-07-31 ("do everything").

## Problem

`mediaFactory.produceVideo` is fully built and tested (`packages/media-factory/src/plugin.ts:185-211`): given a content item that already has a script (from `produce`), it breaks the script into 4 scenes, generates a per-scene image, and calls `publishing.enqueueRender` to queue an actual video render. Nothing calls it — no route, no button. The design doc that built it (`docs/superpowers/plans/2026-07-29-media-factory-video.md`) explicitly scoped it as "not yet wired into autoCycle," on purpose (video rendering is slow and costs real TTS/image generation calls, so it should stay a deliberate Mat-initiated action, not automatic).

Wiring the trigger alone isn't enough to be useful, though. The render pipeline behind `enqueueRender` (`packages/publishing/src/video-queue.ts` + `server.ts`'s `processOneVideoJob`, ticking every 2 minutes) already tracks a job through `queued → rendering → done/failed` in `data/video-jobs.json`, but **nothing exposes that state anywhere** — no op reads a job back, no route serves one, no UI shows one. A bare "Produce Video" button today would queue a job Mat can never check on or retrieve. This design closes that whole loop, not just the trigger.

## Scope

**In scope:**
1. A `getVideoJob` op on the `publishing` plugin, reading `data/video-jobs.json` by job id.
2. A route to trigger `produceVideo`, a route to poll a job's status, and a route to stream the finished mp4.
3. A UI flow on Media Factory content items: a "Produce Video" button on scripted items with no video yet → a live-polling "rendering…" state → a video player once done, or an inline error once failed.

**Out of scope:** any change to the renderer itself (`MontageRenderer`/`VideoRenderer`), the 2-minute worker tick, or `enqueueRender`/`nextQueuedJob`/`markDone`/`markFailed` — all already correct (and the `buildConcatFileContent` bug fixed earlier this session already makes these renders actually succeed). Not in scope: auto-triggering video production from the cycle — stays a manual, deliberate action per the original design's intent.

## Architecture

**`packages/publishing/src/plugin.ts`:** add one op to the existing `ctx.provide("publishing", ...)` handler:

```
if (cmd.op === "getVideoJob") {
  const raw = await readFile(videoJobsPath, "utf8").catch(() => "[]");
  const jobs = JSON.parse(raw) as VideoRenderJob[];
  const job = jobs.find((j) => j.id === cmd.jobId);
  return { job: job ?? null };
}
```

Add the matching variant to `PublishCommand` in `packages/publishing/src/types.ts`: `{ op: "getVideoJob"; jobId: string }`.

**Routes (`packages/server/src/server.ts`):**

- `POST /api/media-factory/produce-video` — body `{contentId}` (required, 400 if missing) → `a.invoke("mediaFactory", {op:"produceVideo", contentId})`, returns `{jobId, sceneCount}`.
- `GET /api/publishing/video-job/:id` — → `a.invoke("publishing", {op:"getVideoJob", jobId: id})`, returns `{job}` (job or null).
- `GET /api/publishing/video/:id` — streams the finished file. Looks up the job via the same `getVideoJob` call; if `job.status !== "done"` or `job.resultPath` is missing, 404. Otherwise reads `job.resultPath` and serves it with `Content-Type: video/mp4`, reusing the exact path-safety pattern already used for images (`resolvePathSafe`, `server.ts:1259-1272`) rather than trusting the stored path directly — `resultPath` is written by the render worker, not user input, but validating it the same way the image route already does costs nothing and matches the codebase's existing convention for anything served straight off disk by id.

**UI (`packages/server/src/html.ts`, inside `loadContentItems()` at `html.ts:1605-1622`):**

- Content items gain an optional `videoJobId` field, set via the existing `PATCH /api/media-factory/content/:id` call right after `produce-video` returns a `jobId` (same pattern `runProductionAgent` already uses to persist `script`/`caption`/`hashtags` back onto the item).
- Render logic per item:
  - `item.status === 'review' && item.script && !item.videoJobId` → show a "🎬 Produce Video" button calling a new `mfProduceVideo(id)`.
  - `item.videoJobId` set, job not yet `done`/`failed` → show "⏳ Rendering video…" and poll `GET /api/publishing/video-job/:id` every 5s (a `setInterval` started when the section is visible, cleared on tab switch — same lifecycle already used elsewhere for polling, if such a precedent exists in this file; otherwise a simple `setInterval` cleared via `clearInterval` when `loadContentItems()` is called again).
  - Job `status === 'done'` → render `<video src="/api/publishing/video/${item.videoJobId}" controls style="max-width:320px">` in place of the rendering indicator.
  - Job `status === 'failed'` → show the job's `error` inline with a "Retry" button that re-calls `mfProduceVideo(id)`.

## Error handling

`produce-video`'s 400 (missing `contentId`) and 500 (op failure, e.g. content item has no script yet — `produceVideo` already throws a clear error for that case) follow the same pattern as every other route in this file. The video-serving route 404s cleanly (no stack traces, no path echoed back) for any job that isn't done, doesn't exist, or whose file went missing from disk — never a 500 for "the video isn't ready," since that's an expected, normal state, not a failure.

## Testing

- `packages/publishing/test/plugin.test.ts` (or wherever `enqueueRender`/`renderQueuedJob` are already tested — follow that file's pattern): a test for `getVideoJob` returning the matching job by id, and returning `null` for an unknown id.
- `packages/server/test/server.test.ts`: route tests for all three new routes — trigger (success + 400 on missing contentId), status poll (found + not-found), and video serving (done job serves the file; non-done/missing job 404s).
- `packages/server/test/page-script.test.ts`: same double-backslash-in-template-literal check as the CFO/Advisors work — must still pass after these changes.
- No new end-to-end render test — the actual rendering path (ffmpeg, Piper TTS) is already covered by the existing render pipeline tests and the live VPS fix earlier this session; this design only adds the trigger/status/serving layer around it.

## Known limitations

1. Polling is a plain 5-second `setInterval`, not a websocket/SSE push — matches the level of real-time-ness already used elsewhere in this UI (nothing else here pushes updates either), and a video render taking minutes doesn't need sub-second updates.
2. One video job per content item at a time (`videoJobId` is a single field, not a list) — matches the existing "Produce Video" op's own scope of one render attempt per item; retrying after a failure overwrites the old job reference rather than keeping history. If Mat wants render history later, that's new scope.
3. The finished video is served by streaming the file straight from wherever the renderer wrote it (`data/temp/...` per `defaultRenderer`'s `tempDir` config) — it is not moved to permanent storage or cleaned up. If disk usage from accumulated renders becomes a problem, that's a separate cleanup task, not part of this design.
