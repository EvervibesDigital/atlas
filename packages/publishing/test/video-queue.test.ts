import { describe, it, expect } from "vitest";
import { enqueueJob, nextQueuedJob, markDone, markFailed, type VideoRenderJob } from "../src/video-queue";

describe("enqueueJob", () => {
  it("adds a new job with status queued, carrying the render spec directly", () => {
    const spec = { voice: "v", scenes: [{ text: "hi", imageUrl: "http://x/1.jpg" }] };
    const jobs = enqueueJob([], spec);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ spec, status: "queued" });
    expect(jobs[0]!.id).toBeTruthy();
    expect(jobs[0]!.requestedAt).toBeTruthy();
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
    expect(updated[0]!.completedAt).toBeTruthy();
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
