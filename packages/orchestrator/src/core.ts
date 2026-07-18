/**
 * Orchestrator core — the autonomous daily loop's pure helpers and its output
 * shape. The loop itself lives in the plugin (it needs the kernel to call
 * departments); these pieces are unit-testable on their own.
 */

/** One optional cycle step's failure, recorded for Mat's human-readable report (see `optional`). */
export interface StepFailure {
  step: string;
  error: string;
}

/** Shared counter threaded through every `optional()` call in one cycle run. */
export interface CycleHealthTracker {
  succeeded: number;
  failures: StepFailure[];
}

const DEFAULT_STEP_TIMEOUT_MS = 90_000;

/**
 * Run one optional cycle step: bounded by a timeout (a hung call must never
 * stall the whole hourly cycle — an unresolved cycle permanently kills the
 * hourly automation loop via its own `isAutomationRunning` guard), and its
 * outcome (success or failure) recorded into `tracker` for Mat's cycle
 * report. `ctx.call()` already logs the raw success/failure to the audit
 * ledger — this tracker is a separate, human-readable summary layer for a
 * different audience (Mat reading "run today's cycle"), not a replacement.
 *
 * Generous default timeout on purpose: this runs on CPU-only local LLM
 * inference where a single brain call can legitimately take 15-40s, and
 * some steps (KDP generate, media factory) may call the brain more than
 * once. A tight timeout would produce FALSE-POSITIVE failures for
 * slow-but-working steps. Running steps in parallel (the caller's job, not
 * this function's) already bounds total wall-clock time to the slowest
 * single step, not their sum, so a generous per-step timeout doesn't
 * meaningfully hurt overall cycle time.
 */
export async function optional<T>(
  call: (service: string, payload: unknown) => Promise<unknown>,
  service: string,
  payload: unknown,
  tracker: CycleHealthTracker,
  timeoutMs: number = DEFAULT_STEP_TIMEOUT_MS,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      call(service, payload),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs); }),
    ]);
    tracker.succeeded++;
    return result as T;
  } catch (err) {
    tracker.failures.push({ step: service, error: err instanceof Error ? err.message : String(err) });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** A single agentic run's output — Mat's "morning report + approval list". */
export interface DailyReport {
  date: string;
  topic: string;
  /** Pass/fail summary for this cycle's optional steps — the one thing Mat
   * should see at a glance without querying /api/runs. Optional because it's
   * only populated once the cycle actually runs through the orchestrator
   * plugin's health tracker — not every DailyReport-shaped value need have it. */
  cycleHealth?: { succeeded: number; failed: number; failures: StepFailure[] };
  /** Lessons recalled from memory at the start of the cycle (closes the learn
   * loop — past successes/failures/findings that informed today's decisions). */
  lessons: string[];
  brief: { summary: string; recommendations: unknown[] };
  /** "The 3 things that matter today" — the top priorities from the brief. */
  topPriorities: unknown[];
  reel: { hook: string; caption: string };
  council: { consensus: string; recommendation: string } | null;
  publish: { status: string; detail: string; approvalId?: string };
  /** Compliance violations found in the drafted caption (empty = clean). */
  compliance: unknown[];
  /** Headline KPIs from the Analytics agent. */
  kpis: unknown;
  /** The business ATLAS studied this cycle (rotates nightly), if any. */
  learned: unknown;
  /** New instructions Mat sent via the GitHub inbox, if configured. */
  inbox: unknown;
  /** Nightly intelligence sweep: curiosity ideas, GitHub repo scouting,
   * free-tool discovery, GitHub sync, and memory tidy (each optional). */
  intel: unknown;
  proposals: unknown[];
  pendingApprovals: unknown[];
}

/** Rotate through a persona's content pillars by day so topics don't repeat. */
export function deriveTopic(pillars: string[], daySeed: number): string {
  if (pillars.length === 0) return "AI tools and automation";
  const pillar = pillars[((daySeed % pillars.length) + pillars.length) % pillars.length]!;
  return `${pillar} tips`;
}

export interface ReelLike {
  personaHandle: string;
  hook: string;
  caption: string;
  hashtags: string[];
  width: number;
  height: number;
  estDurationSec: number;
}

export interface PublishInputLike {
  personaHandle: string;
  videoRef: string | null;
  caption: string;
  hashtags: string[];
  width: number;
  height: number;
  durationSec: number;
}

/** Map a render-ready reel to a publish request. `videoRef` stays null until a
 * real encoder produces the MP4 — then the same shape goes live unchanged. */
export function reelToPublishInput(reel: ReelLike, videoRef: string | null): PublishInputLike {
  return {
    personaHandle: reel.personaHandle,
    videoRef,
    caption: reel.caption,
    hashtags: reel.hashtags,
    width: reel.width,
    height: reel.height,
    durationSec: reel.estDurationSec,
  };
}

export type OrchestratorCommand = {
  op: "runDailyCycle";
  personaHandle?: string;
  topic?: string;
  /** Path to a rendered MP4, if the render step already ran. */
  videoRef?: string | null;
};
