import type { AutonomyTier } from "@atlas/core";

/** A pending item as seen by vitals (a thin slice of a Brief item). */
export interface PendingLike {
  source: string;
  tier?: AutonomyTier;
  createdAt?: string;
}

/** One category's learning metrics (a thin slice of @atlas/learning's metrics). */
export interface LearningMetricLike {
  category: string;
  total: number;
  successRate: number;
}

/** A point-in-time snapshot, persisted so the next check can compute deltas. */
export interface VitalsSnapshot {
  at: string;
  knowledge: number;
  pending: number;
  outcomes: number;
}

/** Everything computeVitals needs, gathered by the plugin from other services. */
export interface VitalsInput {
  pending: PendingLike[];
  /** Total records in long-term memory (memory.count). */
  knowledge: number;
  /** Per-category learning metrics (learning.metrics). */
  metrics: LearningMetricLike[];
  /** The previous snapshot, if any — enables growth/throughput deltas. */
  prev?: VitalsSnapshot;
}

/** ATLAS's self-assessment across the three axes Mat cares about. */
export interface VitalsReport {
  /** Is work FLOWING? (pipeline depth + how long things have been stuck). */
  output: {
    pending: number;
    stalled: number;
    oldestAgeDays: number;
    byTier: Record<AutonomyTier, number>;
  };
  /** Is ATLAS GROWING? (knowledge accumulating, pipeline expanding). */
  growth: {
    knowledge: number;
    knowledgeDelta: number | null;
    pendingDelta: number | null;
  };
  /** Is ATLAS LEARNING? (recording outcomes and improving from them). */
  learning: {
    outcomes: number;
    outcomesDelta: number | null;
    categories: number;
    avgSuccessRate: number | null;
  };
  /** Human-readable alerts — how ATLAS tells Mat it noticed its own problems. */
  flags: string[];
  /** True when nothing is flagged. */
  healthy: boolean;
}

export type VitalsCommand = { op: "check" };
