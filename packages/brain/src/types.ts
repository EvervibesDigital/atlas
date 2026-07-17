/**
 * Brain Router types.
 *
 * The router scores every available model against the *needs* of a request and
 * routes to the best one, with automatic fallback when a provider errors or is
 * rate-limited. Every model is described by its capabilities, cost, and privacy
 * so routing is a transparent, testable calculation — never a hardcoded choice.
 */

/** The dimensions a task can care about (weights 0..1 in a request's `needs`). */
export type Dimension =
  | "coding"
  | "research"
  | "vision"
  | "reasoning"
  | "creativity"
  | "speed"
  | "privacy"
  | "cost"
  /** Hard-filtered like privacy (see meetsUnfiltered) — only the local Dolphin
   *  model declares this, so requesting it always routes there, never soft-scored
   *  against other models' unrelated strengths. */
  | "unfiltered";

export interface BrainRequest {
  prompt: string;
  system?: string;
  /** Free-text label for logging/audit, e.g. "caption.generate". */
  task?: string;
  /** How much each dimension matters for THIS request (0..1). */
  needs?: Partial<Record<Dimension, number>>;
  maxTokens?: number;
  temperature?: number;
}

export interface BrainResponse {
  text: string;
  provider: string;
  model: string;
  latencyMs: number;
  /** 0 for free-tier models. */
  costUsd: number;
  cached: boolean;
  /** Providers that failed before this one succeeded, if any. */
  fallbackFrom?: string[];
}

/** A model's static profile — how good it is per dimension, its cost & privacy. */
export interface ModelSpec {
  /** Provider-specific model id, e.g. "llama-3.1-8b-instant". */
  id: string;
  label: string;
  /** Capability scores per dimension, 0..1. */
  caps: Partial<Record<Dimension, number>>;
  /** Rough per-call cost in USD (0 for free tiers). */
  costUsd: number;
  /** 0 = cloud, 1 = fully local/offline. */
  privacy: number;
  free: boolean;
}

/** A provider (Groq, OpenRouter, Gemini, local stub, …). */
export interface ProviderAdapter {
  name: string;
  models: ModelSpec[];
  /** True when the provider is usable right now (e.g. its API key is present). */
  available(): boolean;
  /** Run one completion. Throws on HTTP/error so the router can fall back. */
  generate(model: ModelSpec, req: BrainRequest): Promise<{ text: string; costUsd: number }>;
}

/** Default needs when a request doesn't specify: cheap + fast, a little reasoning. */
export const DEFAULT_NEEDS: Partial<Record<Dimension, number>> = {
  cost: 1,
  speed: 0.6,
  reasoning: 0.3,
};
