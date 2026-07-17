import type { Dimension, ModelSpec } from "./types";

/** Quality/speed dimensions summed directly from a model's capability scores. */
const QUALITY_DIMS: Dimension[] = ["coding", "research", "vision", "reasoning", "creativity", "speed"];

/**
 * Score a model against a request's needs. Higher is better.
 *
 *   quality  = Σ  needs[d] × model.caps[d]     (for the quality/speed dims)
 *   privacy  = needs.privacy × model.privacy
 *   cost     = needs.cost × (free ? 1 : max(0, 1 − costUsd))
 *
 * The result is a transparent number you can log and reason about.
 */
export function scoreModel(model: ModelSpec, needs: Partial<Record<Dimension, number>>): number {
  let score = 0;
  for (const d of QUALITY_DIMS) {
    score += (needs[d] ?? 0) * (model.caps[d] ?? 0);
  }
  score += (needs.privacy ?? 0) * model.privacy;
  score += (needs.cost ?? 0) * (model.free ? 1 : Math.max(0, 1 - model.costUsd));
  return score;
}

/** True when a model satisfies a hard privacy requirement (needs.privacy ≥ 0.9). */
export function meetsPrivacy(model: ModelSpec, needs: Partial<Record<Dimension, number>>): boolean {
  const required = needs.privacy ?? 0;
  return required < 0.9 || model.privacy >= 0.9;
}

/**
 * True when a model satisfies a hard "unfiltered" requirement (needs.unfiltered
 * ≥ 0.9). A hard filter, not a scored dimension, so requesting it can't be
 * outweighed by another model's strength on coding/reasoning/etc — the exact
 * same pattern as meetsPrivacy above, and for the same reason: some
 * requirements must be guaranteed, not merely favored.
 */
export function meetsUnfiltered(model: ModelSpec, needs: Partial<Record<Dimension, number>>): boolean {
  const required = needs.unfiltered ?? 0;
  return required < 0.9 || (model.caps.unfiltered ?? 0) >= 0.9;
}
