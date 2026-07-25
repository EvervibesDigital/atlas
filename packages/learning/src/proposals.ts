import type { CategoryMetrics, Proposal } from "./types";

/** The problem/suggestion/evidence text for a category's proposal — shared so
 * "adopt" can reconstruct the same text later without the caller re-sending it. */
export function describeProposal(m: CategoryMetrics): Pick<Proposal, "problem" | "suggestion" | "evidence"> {
  return {
    problem: `"${m.category}" is succeeding only ${Math.round(m.successRate * 100)}% of the time (${m.successes}/${m.total}).`,
    suggestion: `Review the approach for "${m.category}" — try different inputs, a stronger model, or adjusted timing. Human review required; do not auto-apply.`,
    evidence: `${m.failures} failures out of ${m.total} attempts`,
  };
}

/**
 * Generate improvement Proposals from metrics. A category is flagged when it
 * has enough samples AND is underperforming. Proposals are SUGGESTIONS only —
 * ATLAS never auto-applies them (constitution: "generate proposals, wait for
 * approval, never automatically rewrite core architecture").
 *
 * `id` is the category itself, not a random id — metrics are recomputed live
 * on every call, so a stable id (rather than a fresh uuid each time) is what
 * lets "adopt"/"dismiss" reliably target the same proposal across calls, and
 * lets `handledCategories` suppress it once Mat has acted on it.
 */
export function generateProposals(
  metrics: CategoryMetrics[],
  handledCategories: Set<string> = new Set(),
  opts: { minSamples?: number; threshold?: number } = {},
): Proposal[] {
  const minSamples = opts.minSamples ?? 3;
  const threshold = opts.threshold ?? 0.5;

  return metrics
    .filter((m) => m.total >= minSamples && m.successRate < threshold && !handledCategories.has(m.category))
    .map((m) => ({
      id: m.category,
      category: m.category,
      status: "open",
      createdAt: new Date().toISOString(),
      ...describeProposal(m),
    }));
}
