import { randomUUID } from "node:crypto";
import type { CategoryMetrics, Proposal } from "./types";

/**
 * Generate improvement Proposals from metrics. A category is flagged when it
 * has enough samples AND is underperforming. Proposals are SUGGESTIONS only —
 * ATLAS never auto-applies them (constitution: "generate proposals, wait for
 * approval, never automatically rewrite core architecture").
 */
export function generateProposals(
  metrics: CategoryMetrics[],
  opts: { minSamples?: number; threshold?: number } = {},
): Proposal[] {
  const minSamples = opts.minSamples ?? 3;
  const threshold = opts.threshold ?? 0.5;

  return metrics
    .filter((m) => m.total >= minSamples && m.successRate < threshold)
    .map((m) => ({
      id: randomUUID(),
      category: m.category,
      problem: `"${m.category}" is succeeding only ${Math.round(m.successRate * 100)}% of the time (${m.successes}/${m.total}).`,
      suggestion: `Review the approach for "${m.category}" — try different inputs, a stronger model, or adjusted timing. Human review required; do not auto-apply.`,
      evidence: `${m.failures} failures out of ${m.total} attempts`,
      status: "open",
      createdAt: new Date().toISOString(),
    }));
}
