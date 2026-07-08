/**
 * Learning types — core principle #4, "every agent learns".
 *
 * The learning layer observes outcomes (from events or explicit reports),
 * writes a Reflection (the lesson), tracks per-category Metrics/confidence, and
 * generates improvement Proposals. Proposals are SUGGESTIONS for Mat — ATLAS
 * never auto-applies changes to itself.
 */
export type Outcome = "success" | "failure";

export interface Reflection {
  event: string;
  outcome: Outcome;
  /** Grouping key: persona handle, agent name, action type, etc. */
  category: string;
  lesson: string;
  detail?: string;
  at: string;
}

export interface CategoryMetrics {
  category: string;
  successes: number;
  failures: number;
  total: number;
  /** successes / total (0 when no data). */
  successRate: number;
  /** Laplace-smoothed rate — a stable confidence even with few samples. */
  confidence: number;
}

export interface Proposal {
  id: string;
  category: string;
  problem: string;
  suggestion: string;
  evidence: string;
  status: "open" | "accepted" | "dismissed";
  createdAt: string;
}

export type LearningCommand =
  | { op: "reflect"; event: string; outcome: Outcome; category: string; detail?: string }
  | { op: "metrics"; category?: string }
  | { op: "proposals" }
  | { op: "reflections"; limit?: number };
