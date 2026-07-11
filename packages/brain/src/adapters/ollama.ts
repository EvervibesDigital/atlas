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

  // NOTE: This laptop has no usable GPU, so inference is CPU-only — model SIZE
  // is the main speed lever. We use a small 3B model (llama3.2:3b) for live chat
  // (fast on CPU), and keep the 7B Qwen as a slower "deep" fallback. Reasoning
  // models (DeepSeek R1) are excluded from live chat: their long chain-of-thought
  // is far too slow on CPU and times out into the stub ("[stub-1]" garbage).
  models: ModelSpec[] = [
    {
      id: "llama3.2:3b",
      label: "Llama 3.2 3B (Local · fast)",
      // Small + fast on CPU. Wins the router for everyday chat.
      caps: { reasoning: 0.72, coding: 0.68, research: 0.7, creativity: 0.72, speed: 0.97 },
      costUsd: 0,
      privacy: 1,
      free: true,
    },
    {
      id: "qwen2.5-coder:7b",
      label: "Qwen2.5 7B (Local · deep)",
      // Smarter but ~2-3x slower on CPU. Only picked if the 3B is unavailable.
      caps: { reasoning: 0.8, coding: 0.85, research: 0.76, creativity: 0.7, speed: 0.4 },
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
          // Cap tokens so replies finish quickly on CPU (a long generation is
          // what times out and triggers stub fallback). 640 is plenty for chat.
          max_tokens: Math.min(req.maxTokens ?? 640, 640),
          top_p: 0.9,
          // Keep the model resident for 30 min so back-to-back messages don't
          // pay the multi-second reload cost each time.
          keep_alive: "30m",
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

      // Reasoning models wrap chain-of-thought in <think>...</think>. Strip it
      // so the owner sees only the final answer, never the raw reasoning.
      // If stripping leaves nothing (e.g. a cut-off all-reasoning reply), fall
      // back to the raw text rather than returning an empty message.
      const stripped = stripReasoning(raw);
      const text = stripped || raw.trim();

      return { text, costUsd: 0 };
    } catch (err) {
      throw new Error(`Ollama: ${String(err)}`);
    }
  }
}
