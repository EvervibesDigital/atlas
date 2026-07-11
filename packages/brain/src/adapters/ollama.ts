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

  // NOTE: On a CPU laptop, reasoning models (DeepSeek R1) generate hundreds of
  // slow chain-of-thought tokens and blow past the request timeout on hard
  // questions — causing a silent fallback to the stub ("[stub-1]" garbage).
  // So for INTERACTIVE chat we use only Qwen: fast (~11s), no <think> overhead,
  // strong general answers. R1 is kept installed for future nightly/deep work
  // via a dedicated slow path — never the live chat.
  models: ModelSpec[] = [
    {
      id: "qwen2.5-coder:7b",
      label: "Qwen2.5 7B (Local)",
      // High across the board so it wins the router for BOTH simple and hard
      // chat needs — the only local model fast enough for real-time use here.
      caps: { reasoning: 0.82, coding: 0.85, research: 0.78, creativity: 0.72, speed: 0.9 },
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
          // what times out and triggers stub fallback). 1024 is plenty for chat.
          max_tokens: Math.min(req.maxTokens ?? 1024, 1024),
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
