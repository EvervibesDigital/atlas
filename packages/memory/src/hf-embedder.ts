import type { Embedder } from "./types";
import { TokenEmbedder } from "./embedder";

/**
 * HuggingFace feature-extraction embedder — real semantic embeddings via the
 * free Inference API (sentence-transformers/all-MiniLM-L6-v2, 384-dim). This is
 * a large recall-quality upgrade over the offline bag-of-words TokenEmbedder:
 * it captures meaning, not just word overlap.
 *
 * IMPORTANT: embeddings from different models live in different vector spaces
 * and are NOT comparable. Do not point this at a memory store that was written
 * by a different embedder — use a dedicated store file (see buildAtlas). If the
 * API is unreachable, it falls back to the offline TokenEmbedder for that call
 * so memory never hard-fails (mixed vectors are tolerated by cosine's min-length
 * guard, though degraded — acceptable for a transient outage).
 */
export class HuggingFaceEmbedder implements Embedder {
  private fallback = new TokenEmbedder();
  private model: string;

  constructor(
    private apiKey: string,
    model = "sentence-transformers/all-MiniLM-L6-v2",
  ) {
    this.model = model;
  }

  async embed(text: string): Promise<number[]> {
    if (!this.apiKey) return this.fallback.embed(text);
    try {
      const res = await fetch(`https://api-inference.huggingface.co/pipeline/feature-extraction/${this.model}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ inputs: text, options: { wait_for_model: true } }),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as number[] | number[][];
      // The API returns a flat vector for a single string, or nested for tokens.
      const vec = Array.isArray(data[0]) ? (data as number[][])[0]! : (data as number[]);
      if (!Array.isArray(vec) || vec.length === 0) throw new Error("empty embedding");
      return vec;
    } catch {
      // Transient failure — degrade to offline embedder rather than throwing.
      return this.fallback.embed(text);
    }
  }
}
