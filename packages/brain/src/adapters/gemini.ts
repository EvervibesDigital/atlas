import type { BrainRequest, ModelSpec, ProviderAdapter } from "../types";

/**
 * Google Gemini adapter — unlimited free tokens (500K tokens/min rate limit).
 * Best value for ATLAS: better than Groq's 1K/day limit.
 * Get free API key from aistudio.google.com (no credit card).
 */
export class GeminiAdapter implements ProviderAdapter {
  name = "gemini";

  models: ModelSpec[] = [
    {
      id: "gemini-3.5-flash",
      label: "Gemini 3.5 Flash (best all-rounder, free unlimited)",
      caps: { reasoning: 0.88, coding: 0.90, research: 0.85, creativity: 0.84, speed: 0.96 },
      costUsd: 0,
      privacy: 0.75,
      free: true,
    },
    {
      id: "gemini-3.1-flash-lite",
      label: "Gemini 3.1 Flash-Lite (faster, lighter)",
      caps: { reasoning: 0.80, coding: 0.85, research: 0.82, creativity: 0.78, speed: 0.98 },
      costUsd: 0,
      privacy: 0.75,
      free: true,
    },
    {
      id: "gemini-3-flash-preview",
      label: "Gemini 3 Flash (preview)",
      caps: { reasoning: 0.85, coding: 0.87, research: 0.84, creativity: 0.81, speed: 0.94 },
      costUsd: 0,
      privacy: 0.75,
      free: true,
    },
  ];

  constructor(private apiKey?: string) {}

  available(): boolean {
    return !!this.apiKey;
  }

  async generate(model: ModelSpec, req: BrainRequest): Promise<{ text: string; costUsd: number }> {
    if (!this.apiKey) {
      throw new Error("Gemini: no API key. Get free key from aistudio.google.com");
    }

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:generateContent?key=${this.apiKey}`;

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // system_instruction must be a Content object ({parts:[{text}]}) —
          // a raw string is rejected with HTTP 400 "Invalid value".
          ...(req.system ? { system_instruction: { parts: [{ text: req.system }] } } : {}),
          contents: [
            {
              role: "user",
              parts: [{ text: req.prompt }],
            },
          ],
          generationConfig: {
            temperature: req.temperature ?? 0.7,
            maxOutputTokens: Math.min(req.maxTokens ?? 1024, 2000),
            topP: 0.95,
          },
          safetySettings: [
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
          ],
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 150)}`);
      }

      const data = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        error?: { message?: string };
      };

      if (data.error) {
        throw new Error(data.error.message || "unknown error");
      }

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      if (!text) throw new Error("empty response");

      return { text, costUsd: 0 };
    } catch (err) {
      throw new Error(`Gemini: ${String(err)}`);
    }
  }
}
