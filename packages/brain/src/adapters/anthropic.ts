import type { BrainRequest, ModelSpec, ProviderAdapter } from "../types";

/**
 * Anthropic (Claude) — the premium brain. Opus 4.8 / Fable 5 / Sonnet 5 /
 * Haiku 4.5. Requires ANTHROPIC_API_KEY *with credits* (pay-as-you-go; Claude
 * Code Pro does NOT provide API credits). Costs are set high so the router only
 * reaches for these when quality is explicitly prioritized (e.g. an "opus:"
 * chat) — never for cheap bulk/autonomous work.
 */
export class AnthropicAdapter implements ProviderAdapter {
  name = "anthropic";
  models: ModelSpec[] = [
    { id: "claude-opus-4-8", label: "Claude Opus 4.8", caps: { reasoning: 0.99, coding: 0.97, research: 0.95, creativity: 0.95, speed: 0.4 }, costUsd: 0.9, privacy: 0, free: false },
    { id: "claude-fable-5", label: "Claude Fable 5", caps: { reasoning: 0.95, coding: 0.9, research: 0.9, creativity: 0.98, speed: 0.6 }, costUsd: 0.6, privacy: 0, free: false },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5", caps: { reasoning: 0.93, coding: 0.92, research: 0.9, creativity: 0.9, speed: 0.7 }, costUsd: 0.25, privacy: 0, free: false },
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", caps: { reasoning: 0.82, coding: 0.8, research: 0.78, creativity: 0.75, speed: 0.9 }, costUsd: 0.06, privacy: 0, free: false },
  ];

  constructor(private apiKey?: string) {}

  available(): boolean {
    return !!this.apiKey;
  }

  async generate(model: ModelSpec, req: BrainRequest): Promise<{ text: string; costUsd: number }> {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": this.apiKey!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: model.id,
        max_tokens: req.maxTokens ?? 1024,
        ...(req.system ? { system: req.system } : {}),
        messages: [{ role: "user", content: req.prompt }],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`anthropic HTTP ${res.status}: ${body.slice(0, 160)}`);
    }
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = (data.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
    return { text, costUsd: model.costUsd };
  }
}
