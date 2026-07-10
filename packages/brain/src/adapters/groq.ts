import type { BrainRequest, ModelSpec, ProviderAdapter } from "../types";
import { openaiChat } from "./shared";

/** Groq — free tier, extremely fast. Best for high-volume, simple tasks. */
export class GroqAdapter implements ProviderAdapter {
  name = "groq";
  models: ModelSpec[] = [
    {
      id: "llama-3.3-70b-versatile",
      label: "Llama 3.3 70B (Groq)",
      caps: { reasoning: 0.85, coding: 0.75, research: 0.75, creativity: 0.72, speed: 0.85 },
      costUsd: 0,
      privacy: 0,
      free: true,
    },
    {
      id: "llama-3.1-8b-instant",
      label: "Llama 3.1 8B Instant (Groq)",
      caps: { speed: 0.95, reasoning: 0.5, coding: 0.5, research: 0.5, creativity: 0.5 },
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
      url: "https://api.groq.com/openai/v1/chat/completions",
      apiKey: this.apiKey!,
      model: model.id,
      req,
    });
    return { text, costUsd: 0 };
  }
}
