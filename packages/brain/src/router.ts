import type { BrainRequest, BrainResponse, ProviderAdapter } from "./types";
import { DEFAULT_NEEDS } from "./types";
import { scoreModel, meetsPrivacy, meetsUnfiltered } from "./scorer";
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

    candidates = candidates.filter((c) => meetsUnfiltered(c.model, needs));
    if (candidates.length === 0) throw new Error("Brain Router: unfiltered mode requested but no unfiltered model is available (pull dolphin3:8b and set ATLAS_ENABLE_UNFILTERED)");

    const ranked = candidates
      .map((c) => ({ ...c, score: scoreModel(c.model, needs) }))
      .sort((a, b) => b.score - a.score);

    const fallbackFrom: string[] = [];
    const failures: string[] = [];
    let lastError: unknown;
    for (const c of ranked) {
      const start = Date.now();
      const isRealProvider = c.adapter.name !== "stub";
      try {
        const { text, costUsd } = await c.adapter.generate(c.model, req);

        // If we only got an answer from the offline stub AFTER real providers
        // failed, surface WHY — so a "[stub-1] …" reply is never a silent mystery.
        const diagnostic =
          !isRealProvider && failures.length
            ? `⚠️ Live brains unavailable, using offline stub. Reasons:\n${failures.map((f) => `  • ${f}`).join("\n")}\n\n`
            : "";

        const resp: BrainResponse = {
          text: diagnostic + text,
          provider: c.adapter.name,
          model: c.model.id,
          latencyMs: Date.now() - start,
          costUsd,
          cached: false,
          fallbackFrom: fallbackFrom.length ? [...fallbackFrom] : undefined,
        };
        // Never cache a stub/diagnostic answer — we want the real one next time.
        if (isRealProvider) this.cache.set(cacheKey, resp);
        return resp;
      } catch (err) {
        lastError = err;
        fallbackFrom.push(`${c.adapter.name}:${c.model.id}`);
        const reason = err instanceof Error ? err.message : String(err);
        failures.push(`${c.adapter.name}:${c.model.id} → ${reason.slice(0, 180)}`);
        // Log to the server console so failures are never silently swallowed.
        console.error(`[brain] ${c.adapter.name}:${c.model.id} failed: ${reason.slice(0, 300)}`);
      }
    }
    throw new Error(`Brain Router: all providers failed (${fallbackFrom.join(", ")}) — ${String(lastError)}`);
  }
}
