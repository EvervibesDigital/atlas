import type { BrainRequest, BrainResponse, ProviderAdapter } from "./types";
import { DEFAULT_NEEDS } from "./types";
import { scoreModel, meetsPrivacy } from "./scorer";
import { PromptCache } from "./cache";

interface Candidate {
  adapter: ProviderAdapter;
  model: import("./types").ModelSpec;
}

/**
 * Brain Router — picks the best available model per request and falls back
 * automatically when one errors or is rate-limited. Adapters are injected, so
 * the whole thing is testable offline with a stub (no keys, no cost).
 */
export class BrainRouter {
  constructor(
    private adapters: ProviderAdapter[],
    private cache: PromptCache = new PromptCache(),
  ) {}

  /** Every model from every provider that is usable right now. */
  availableModels(): Candidate[] {
    return this.adapters
      .filter((a) => a.available())
      .flatMap((a) => a.models.map((model) => ({ adapter: a, model })));
  }

  async generate(req: BrainRequest): Promise<BrainResponse> {
    const cacheKey = this.cache.key(req);
    const hit = this.cache.get(cacheKey);
    if (hit) return { ...hit, cached: true, latencyMs: 0, fallbackFrom: undefined };

    const needs = req.needs ?? DEFAULT_NEEDS;

    let candidates = this.availableModels();
    if (candidates.length === 0) throw new Error("Brain Router: no available LLM providers");

    candidates = candidates.filter((c) => meetsPrivacy(c.model, needs));
    if (candidates.length === 0) throw new Error("Brain Router: no provider meets the privacy requirement");

    const ranked = candidates
      .map((c) => ({ ...c, score: scoreModel(c.model, needs) }))
      .sort((a, b) => b.score - a.score);

    const fallbackFrom: string[] = [];
    let lastError: unknown;
    for (const c of ranked) {
      const start = Date.now();
      try {
        const { text, costUsd } = await c.adapter.generate(c.model, req);
        const resp: BrainResponse = {
          text,
          provider: c.adapter.name,
          model: c.model.id,
          latencyMs: Date.now() - start,
          costUsd,
          cached: false,
          fallbackFrom: fallbackFrom.length ? [...fallbackFrom] : undefined,
        };
        this.cache.set(cacheKey, resp);
        return resp;
      } catch (err) {
        lastError = err;
        fallbackFrom.push(`${c.adapter.name}:${c.model.id}`);
      }
    }
    throw new Error(`Brain Router: all providers failed (${fallbackFrom.join(", ")}) — ${String(lastError)}`);
  }
}
