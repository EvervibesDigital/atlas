import type { BrainRequest, ModelSpec, ProviderAdapter } from "../types";

/**
 * Hugging Face Inference API adapter — 45K+ models, free tier generous.
 * Free tier includes text generation, images, audio, embeddings, search.
 * Get free token from huggingface.co (no credit card required).
 */
export class HuggingFaceAdapter implements ProviderAdapter {
  name = "huggingface";

  models: ModelSpec[] = [
    {
      id: "meta-llama/Meta-Llama-3.1-8B-Instruct",
      label: "Llama 3.1 8B Instruct (free tier)",
      caps: { reasoning: 0.82, coding: 0.86, research: 0.83, creativity: 0.80, speed: 0.85 },
      costUsd: 0,
      privacy: 0.8,
      free: true,
    },
    {
      id: "mistralai/Mistral-7B-Instruct-v0.2",
      label: "Mistral 7B (free tier)",
      caps: { reasoning: 0.85, coding: 0.88, research: 0.82, creativity: 0.78, speed: 0.88 },
      costUsd: 0,
      privacy: 0.8,
      free: true,
    },
    {
      id: "NousResearch/Nous-Hermes-2-Mixtral-8x7B-DPO",
      label: "Hermes 2 Mixtral (expert routing)",
      caps: { reasoning: 0.90, coding: 0.92, research: 0.88, creativity: 0.82, speed: 0.80 },
      costUsd: 0,
      privacy: 0.8,
      free: true,
    },
  ];

  constructor(private apiKey?: string) {}

  available(): boolean {
    return !!this.apiKey;
  }

  async generate(model: ModelSpec, req: BrainRequest): Promise<{ text: string; costUsd: number }> {
    if (!this.apiKey) {
      throw new Error("HuggingFace: no token. Get free token from huggingface.co");
    }

    try {
      const url = `https://api-inference.huggingface.co/models/${model.id}`;

      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          inputs: req.system ? `${req.system}\n\n${req.prompt}` : req.prompt,
          parameters: {
            max_new_tokens: Math.min(req.maxTokens ?? 512, 1024),
            temperature: req.temperature ?? 0.7,
            top_p: 0.95,
          },
          options: {
            wait_for_model: true, // Wait if model is loading
          },
        }),
        signal: AbortSignal.timeout(45000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 150)}`);
      }

      const data = (await res.json()) as Array<{ generated_text?: string }> | { error?: string };

      // Handle different response formats
      let text = "";
      if (Array.isArray(data)) {
        text = data[0]?.generated_text ?? "";
      } else if ("error" in data) {
        throw new Error(data.error || "unknown error");
      }

      if (!text) throw new Error("empty response");

      // Remove system instruction from output if present
      if (req.system && text.includes(req.system)) {
        text = text.replace(req.system, "").trim();
      }

      return { text, costUsd: 0 };
    } catch (err) {
      throw new Error(`HuggingFace: ${String(err)}`);
    }
  }
}
