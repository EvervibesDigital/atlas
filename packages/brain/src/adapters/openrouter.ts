import type { BrainRequest, ModelSpec, ProviderAdapter } from "../types";
import { openaiChat } from "./shared";

/** OpenRouter — one key, many free models. Best for quality reasoning/coding. */
export class OpenRouterAdapter implements ProviderAdapter {
  name = "openrouter";
  // Note: OpenRouter's free tier removed DeepSeek R1/V3 (now paid, 404 on :free).
  // Kept model is real but heavily rate-limited, so it sits BELOW Groq 70B and
  // acts as a backup only.
  models: ModelSpec[] = [
    {
      id: "meta-llama/llama-3.3-70b-instruct:free",
      label: "Llama 3.3 70B (OpenRouter free)",
      caps: { reasoning: 0.78, coding: 0.7, research: 0.7, creativity: 0.68, speed: 0.5 },
      costUsd: 0,
      privacy: 0,
      free: true,
    },
  ];

  constructor(private apiKey?: string) {}

  available(): boolean {
    return !!this.apiKey;
  }

  async generate(model: ModelSpec, req: BrainRequest): Promise<{ text: string; costUsd: number }> {
    const text = await openaiChat({
      url: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: this.apiKey!,
      model: model.id,
      req,
      extraHeaders: { "X-Title": "ATLAS" },
    });
    return { text, costUsd: 0 };
  }
}
