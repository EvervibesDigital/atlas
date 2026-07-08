/**
 * Orchestrator core — the autonomous daily loop's pure helpers and its output
 * shape. The loop itself lives in the plugin (it needs the kernel to call
 * departments); these pieces are unit-testable on their own.
 */

/** A single agentic run's output — Mat's "morning report + approval list". */
export interface DailyReport {
  date: string;
  topic: string;
  brief: { summary: string; recommendations: unknown[] };
  reel: { hook: string; caption: string };
  council: { consensus: string; recommendation: string } | null;
  publish: { status: string; detail: string; approvalId?: string };
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
