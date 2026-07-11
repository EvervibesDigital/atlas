import type { BrainRequest, BrainResponse, ProviderAdapter, ModelSpec } from "../types";

/**
 * Ollama adapter — local LLM via OpenAI-compatible API at http://localhost:11434.
 * No API key. No rate limits. Unlimited free use.
 */

const getEndpoint = (): string => {
  const base = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
  return `${base}/v1/chat/completions`;
};

export class OllamaAdapter implements ProviderAdapter {
  name = "ollama";

  models: ModelSpec[] = [
    {
      id: "deepseek-r1:7b",
      label: "DeepSeek R1 7B (Local)",
      caps: { reasoning: 0.8, coding: 0.78, research: 0.75, creativity: 0.7, speed: 0.7 },
      costUsd: 0,
      privacy: 1,
      free: true,
    },
    {
      id: "deepseek-r1:14b",
      label: "DeepSeek R1 14B (Local)",
      caps: { reasoning: 0.85, coding: 0.82, research: 0.8, creativity: 0.75, speed: 0.5 },
      costUsd: 0,
      privacy: 1,
      free: true,
    },
  ];

  available(): boolean {
    return true;
  }

  async generate(model: ModelSpec, req: BrainRequest): Promise<{ text: string; costUsd: number }> {
    const endpoint = getEndpoint();

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: model.id.split(":")[0],
          messages: [
            ...(req.system ? [{ role: "system" as const, content: req.system }] : []),
            { role: "user" as const, content: req.prompt },
          ],
          temperature: 0.7,
          max_tokens: req.maxTokens ?? 2048,
          top_p: 0.9,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Ollama ${response.status}: ${text.slice(0, 200)}`);
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = data.choices?.[0]?.message?.content ?? "";
      if (!text) throw new Error("Ollama: empty response");

      return { text, costUsd: 0 };
    } catch (err) {
      throw new Error(`Ollama: ${String(err)}`);
    }
  }
}
