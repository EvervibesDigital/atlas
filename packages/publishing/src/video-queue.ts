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
