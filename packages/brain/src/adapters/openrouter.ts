import type { BrainRequest, ModelSpec, ProviderAdapter } from "../types";
import { openaiChat } from "./shared";

/** OpenRouter — one key, many free models. Best for quality reasoning/coding. */
export class OpenRouterAdapter implements ProviderAdapter {
  name = "openrouter";
  models: ModelSpec[] = [
    {
      id: "deepseek/deepseek-r1:free",
      label: "DeepSeek R1 (free)",
      caps: { reasoning: 0.9, coding: 0.7, research: 0.7, creativity: 0.6, speed: 0.4 },
      costUsd: 0,
      privacy: 0,
      free: true,
    },
    {
      id: "meta-llama/llama-3.3-70b-instruct:free",
      label: "Llama 3.3 70B (free)",
      caps: { reasoning: 0.8, coding: 0.7, research: 0.7, creativity: 0.7, speed: 0.5 },
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
