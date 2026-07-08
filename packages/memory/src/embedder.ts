import type { Embedder } from "./types";

/** Fixed embedding size. Small is fine for the offline token embedder. */
export const EMBED_DIM = 256;

/** FNV-1a hash → bucket index in [0, EMBED_DIM). */
function bucket(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % EMBED_DIM;
}

/** Common function words that create false matches; ignored when embedding. */
const STOPWORDS = new Set([
  "a", "an", "the", "of", "on", "in", "to", "for", "and", "or", "but", "with",
  "that", "this", "is", "are", "was", "were", "be", "at", "by", "it", "as",
  "from", "what", "how", "why", "when", "where", "which", "who", "kind", "your",
  "you", "i", "we", "they", "will", "can", "do", "does", "so", "my",
]);

/** Lowercase already; drop a trailing plural "s" so hook ≈ hooks, deal ≈ deals. */
function normalizeToken(tok: string): string {
  if (tok.length > 3 && tok.endsWith("s") && !tok.endsWith("ss")) return tok.slice(0, -1);
  return tok;
}

/**
 * Offline, deterministic embedder. Tokenizes, drops stopwords, light plural
 * stemming, then hashes tokens into a bag-of-words vector and L2-normalizes.
 * Cosine similarity reflects meaningful word overlap — crude but genuinely
 * useful, zero-cost, no network. A real embedding-model adapter can replace
 * this later behind the same interface.
 */
export class TokenEmbedder implements Embedder {
  async embed(text: string): Promise<number[]> {
    const vec = new Array<number>(EMBED_DIM).fill(0);
    const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    for (const raw of tokens) {
      if (STOPWORDS.has(raw)) continue;
      const idx = bucket(normalizeToken(raw));
      vec[idx] = (vec[idx] ?? 0) + 1;
    }
    return normalize(vec);
  }
}

/** L2-normalize so cosine similarity is just a dot product. */
export function normalize(vec: number[]): number[] {
  let mag = 0;
  for (const v of vec) mag += v * v;
  mag = Math.sqrt(mag);
  if (mag === 0) return vec;
  return vec.map((v) => v / mag);
}

/** Cosine similarity of two equal-length vectors. */
export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}
