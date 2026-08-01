import { randomUUID } from "node:crypto";
import type { PublishInput } from "./types";

export interface VideoRenderJob {
  id: string;
  /** The exact render spec MontageRenderer.render() expects — carried
   * directly on the job (not a foreign-key lookup) since the source reel
   * only ever exists in-memory during the orchestrator's cycle, with
   * nothing durable to look it back up from later. */
  spec: unknown;
  /** Set when the caller wants to find this job again by content item
   * (Media Factory) rather than only by job id (the orchestrator's own
   * daily Reel doesn't set this — it has nothing to look it back up for). */
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

/** Add a new queued job carrying the given render spec. Pure — caller
 * persists the returned array (same load/mutate/save pattern as
 * automation.json). */
export function enqueueJob(jobs: VideoRenderJob[], spec: unknown, contentId?: string, publishInput?: Omit<PublishInput, "videoRef">): VideoRenderJob[] {
  return [...jobs, { id: randomUUID(), spec, contentId, publishInput, status: "queued", requestedAt: new Date().toISOString() }];
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
