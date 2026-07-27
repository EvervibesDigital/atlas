import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Atlas, type GuardianLike } from "@atlas/core";
import { createPublishingPlugin } from "../src/plugin";
import type { Renderer } from "../src/video-renderer";
import type { VideoRenderJob } from "../src/video-queue";

function permissiveGuardian(): GuardianLike {
  return {
    grant: () => {},
    check: () => ({ decision: "allow", reason: "test" }),
  };
}

function fakeRenderer(videoPath: string): Renderer & { calls: unknown[] } {
  return {
    calls: [] as unknown[],
    async render(spec) {
      this.calls.push(spec);
      return videoPath;
    },
  };
}

describe("publishing plugin — enqueueRender / renderQueuedJob", () => {
  let dataDir: string;
  let videoJobsFile: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "atlas-publishing-test-"));
    videoJobsFile = join(dataDir, "video-jobs.json");
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("enqueueRender queues a job with the given spec and persists it to disk", async () => {
    const atlas = new Atlas({ guardian: permissiveGuardian() });
    await atlas.use(createPublishingPlugin({ renderer: fakeRenderer("x.mp4"), videoJobsFile }));

    const spec = { voice: "v1", scenes: [{ text: "hi", imageUrl: "http://x/1.jpg" }] };
    const result = (await atlas.invoke("publishing", { op: "enqueueRender", spec })) as { jobId: string };

    expect(result.jobId).toBeTruthy();
    const raw = await readFile(videoJobsFile, "utf8");
    const jobs = JSON.parse(raw) as VideoRenderJob[];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: result.jobId, spec, status: "queued" });
  });

  it("renderQueuedJob calls the renderer with the exact spec and returns its result", async () => {
    const renderer = fakeRenderer("rendered/output.mp4");
    const atlas = new Atlas({ guardian: permissiveGuardian() });
    await atlas.use(createPublishingPlugin({ renderer, videoJobsFile }));

    const spec = { voice: "v2", scenes: [{ text: "scene one", imageUrl: "http://x/2.jpg" }] };
    const result = (await atlas.invoke("publishing", { op: "renderQueuedJob", spec })) as { videoPath: string };

    expect(result.videoPath).toBe("rendered/output.mp4");
    expect(renderer.calls).toEqual([spec]);
  });
});
