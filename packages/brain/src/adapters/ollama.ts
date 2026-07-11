import type { BrainRequest, ProviderAdapter, ModelSpec } from "../types";

/**
 * Ollama adapter — local LLM via OpenAI-compatible API at http://localhost:11434.
 * No API key. No rate limits. Unlimited free use.
 */

const getEndpoint = (): string => {
  const base = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
  return `${base}/v1/chat/completions`;
};

/**
 * Remove reasoning-model chain-of-thought. DeepSeek R1 emits <think>…</think>
 * before its answer; sometimes the opening tag is dropped and only the closing
 * </think> survives. We handle both, then trim leftover whitespace.
 */
export function stripReasoning(raw: string): string {
  let out = raw;
  // Full <think>…</think> pairs (including multiline).
  out = out.replace(/<think>[\s\S]*?<\/think>/gi, "");
  // A dangling closing tag: keep only what follows the last </think>.
  const lastClose = out.lastIndexOf("</think>");
  if (lastClose !== -1) out = out.slice(lastClose + "</think>".length);
  // A dangling opening tag with no close: drop everything after it.
  const openIdx = out.indexOf("<think>");
  if (openIdx !== -1) out = out.slice(0, openIdx);
  return out.trim();
}

export class OllamaAdapter implements ProviderAdapter {
  name = "ollama";

  models: ModelSpec[] = [
    {
      // Fast path — no chain-of-thought overhead. Wins for short/simple asks
      // (router weights speed there) so everyday chat feels instant.
      id: "qwen2.5-coder:7b",
      label: "Qwen2.5 7B (Local · fast)",
      caps: { reasoning: 0.6, coding: 0.85, research: 0.6, creativity: 0.6, speed: 0.9 },
      costUsd: 0,
      privacy: 1,
      free: true,
    },
    {
      // Deep path — reasoning model. Wins for hard/strategy asks (router weights
      // reasoning there). Slower because it "thinks" first; <think> is stripped.
      id: "deepseek-r1:7b",
      label: "DeepSeek R1 7B (Local · deep)",
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
      // Ollama can be slow (model loading, inference on CPU).
      // Give it up to 120 seconds — it's worth the wait for unlimited free brain.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120000);

      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: model.id,
          messages: [
            ...(req.system ? [{ role: "system" as const, content: req.system }] : []),
            { role: "user" as const, content: req.prompt },
          ],
          temperature: 0.7,
          max_tokens: req.maxTokens ?? 2048,
          top_p: 0.9,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Ollama ${response.status}: ${text.slice(0, 200)}`);
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const raw = data.choices?.[0]?.message?.content ?? "";
      if (!raw) throw new Error("Ollama: empty response");

      // DeepSeek R1 (and other reasoning models) emit their chain-of-thought
      // wrapped in <think>...</think>. Strip it so the owner sees only the
      // final answer, never the raw reasoning ("slop").
      const text = stripReasoning(raw);

      return { text, costUsd: 0 };
    } catch (err) {
      throw new Error(`Ollama: ${String(err)}`);
    }
  }
}
