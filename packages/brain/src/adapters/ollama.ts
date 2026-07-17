import type { BrainRequest, ProviderAdapter, ModelSpec } from "../types";

/**
 * Ollama adapter — local LLM via OpenAI-compatible API at http://localhost:11434.
 * No API key. No rate limits. Unlimited free use.
 */

const getEndpoint = (): string => {
  // Use 127.0.0.1 (IPv4) not "localhost": Node's fetch resolves localhost to
  // IPv6 ::1 first, waits ~13s for it to fail (Ollama binds IPv4 only), THEN
  // falls back. That delay alone can push a reply past downstream timeouts.
  const base = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
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

  // This laptop is CPU-only, so model SIZE is the main speed lever. We expose
  // exactly ONE small, fast model (llama3.2:3b) for local inference by default.
  // Deep/coding work is handled by the cloud adapters (Gemini/Groq/HuggingFace)
  // when a key is present; Ollama is the always-available offline floor. Exposing
  // the 7B/30B here would let the router pick a 30–90s reply for ordinary
  // questions — the exact slowness we fixed before. One fast model = predictable
  // local latency.
  //
  // Qwen3.6 35B-A3B (MoE, ~3B active params/token, ~24GB download) is exposed
  // ONLY when ATLAS_ENABLE_QWEN36 is truthy — same double-gating as the HF
  // embedder, because a 24GB model pull is a deliberate, disk/RAM-heavy choice
  // Mat should opt into, not something that starts silently. Even with the MoE
  // speedup it's still far slower than the 3B default, so `speed` is scored low
  // on purpose: it should only win when a request explicitly weights reasoning/
  // coding heavily, not for ordinary chat.
  models: ModelSpec[] = [
    {
      id: "llama3.2:3b",
      label: "Llama 3.2 3B (Local, offline)",
      // speed kept modest so a keyed cloud model (higher quality) wins when
      // available; when no cloud key exists, Ollama is the only real option and
      // wins regardless. privacy 1 = fully local.
      caps: { reasoning: 0.72, coding: 0.68, research: 0.7, creativity: 0.72, speed: 0.6 },
      costUsd: 0,
      privacy: 1,
      free: true,
    },
    ...(process.env.ATLAS_ENABLE_QWEN36
      ? [
          {
            id: "qwen3.6:35b-a3b",
            label: "Qwen3.6 35B-A3B (Local, offline, MoE)",
            caps: { reasoning: 0.88, coding: 0.86, research: 0.82, creativity: 0.8, speed: 0.25 },
            costUsd: 0,
            privacy: 1,
            free: true,
          } satisfies ModelSpec,
        ]
      : []),
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
          // Cap tokens so replies finish quickly on CPU — generation length is
          // the main cost without a GPU. 400 keeps local replies reasonably snappy.
          max_tokens: Math.min(req.maxTokens ?? 400, 400),
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
