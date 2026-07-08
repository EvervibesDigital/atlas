import { randomUUID } from "node:crypto";
import type { Embedder, MemoryInput, MemoryKind, MemoryRecord, MemoryStore, SearchOptions, SearchResult } from "./types";
import { TokenEmbedder, cosine } from "./embedder";

/**
 * Memory — remember / search / recall / forget over any MemoryStore.
 * Search is semantic: the query is embedded and compared by cosine similarity
 * to every stored record (optionally filtered by kind).
 */
export class Memory {
  constructor(
    private store: MemoryStore,
    private embedder: Embedder = new TokenEmbedder(),
  ) {}

  async remember(input: MemoryInput): Promise<MemoryRecord> {
    const embedding = await this.embedder.embed(input.content);
    const record: MemoryRecord = {
      id: randomUUID(),
      kind: input.kind,
      content: input.content,
      embedding,
      metadata: input.metadata ?? {},
      createdAt: new Date().toISOString(),
    };
    await this.store.put(record);
    return record;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const q = await this.embedder.embed(query);
    const all = await this.store.all();
    const pool = options.kind ? all.filter((r) => r.kind === options.kind) : all;
    const minScore = options.minScore ?? 0;
    const limit = options.limit ?? 5;
    return pool
      .map((record) => ({ record, score: cosine(q, record.embedding) }))
      .filter((s) => s.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async recent(kind?: MemoryKind, limit = 10): Promise<MemoryRecord[]> {
    const all = await this.store.all();
    const pool = kind ? all.filter((r) => r.kind === kind) : all;
    return pool.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  async forget(id: string): Promise<boolean> {
    return this.store.delete(id);
  }
}
