import type { BrainRequest, ModelSpec, ProviderAdapter } from "../types";

/** Google Gemini — free Flash tier. Solid all-rounder, generous context. */
export class GeminiAdapter implements ProviderAdapter {
  name = "gemini";
  models: ModelSpec[] = [
    {
      id: "gemini-flash-latest",
      label: "Gemini Flash (free)",
      caps: { reasoning: 0.6, coding: 0.6, research: 0.7, creativity: 0.6, speed: 0.8, vision: 0.7 },
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
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:generateContent?key=${this.apiKey!}`;
    const prompt = req.system ? `${req.system}\n\n${req.prompt}` : req.prompt;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: req.temperature ?? 0.7, maxOutputTokens: req.maxTokens ?? 1024 },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`gemini → HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    return { text, costUsd: 0 };
  }
}
