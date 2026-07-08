import type { BrainRequest, ModelSpec, ProviderAdapter } from "../types";

/**
 * Offline stub provider. ALWAYS available, fully private (privacy = 1), free,
 * deterministic. Two jobs:
 *   1. ATLAS runs with zero API keys (nothing crashes for lack of a provider).
 *   2. It is the fallback when a request demands high privacy / offline.
 *
 * Its capability scores are deliberately LOW so that whenever a real provider
 * is available, the router prefers the real one.
 */
export class StubAdapter implements ProviderAdapter {
  name = "stub";
  models: ModelSpec[] = [
    {
      id: "stub-1",
      label: "Offline Stub",
      caps: { coding: 0.2, research: 0.2, reasoning: 0.2, creativity: 0.2, speed: 0.3 },
      costUsd: 0,
      privacy: 1,
      free: true,
    },
  ];

  available(): boolean {
    return true;
  }

  async generate(model: ModelSpec, req: BrainRequest): Promise<{ text: string; costUsd: number }> {
    const preview = req.prompt.replace(/\s+/g, " ").trim().slice(0, 200);
    return { text: `[${model.id}] ${preview}`, costUsd: 0 };
  }
}
