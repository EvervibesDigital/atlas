/**
 * Memory types.
 *
 * ATLAS never forgets unless told to. Every learning, outcome, preference, and
 * event is a MemoryRecord with a vector embedding so it can be found by meaning,
 * not just keywords. The store is pluggable (in-memory → JSON file → pgvector)
 * so persistence can grow without changing callers.
 */

/** The memory categories from the ATLAS constitution. */
export type MemoryKind =
  | "semantic"
  | "business"
  | "project"
  | "agent"
  | "conversation"
  | "success"
  | "failure"
  | "preference"
  | "timeline"
  | "relationship";

export interface MemoryRecord {
  id: string;
  kind: MemoryKind;
  content: string;
  /** Vector embedding of `content`, used for semantic search. */
  embedding: number[];
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface MemoryInput {
  kind: MemoryKind;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface SearchOptions {
  kind?: MemoryKind;
  limit?: number;
  /** Drop results below this cosine similarity (0..1). */
  minScore?: number;
}

export interface SearchResult {
  record: MemoryRecord;
  score: number;
}

/** Turns text into a vector. Default is offline/deterministic; swap for a real
 * embedding model later without touching callers. */
export interface Embedder {
  embed(text: string): Promise<number[]>;
}

/** Storage backend. In-memory (tests), JSON file (offline persistence), or
 * Postgres+pgvector (later) all implement this. */
export interface MemoryStore {
  put(record: MemoryRecord): Promise<void>;
  all(): Promise<MemoryRecord[]>;
  delete(id: string): Promise<boolean>;
}

/** Commands accepted by the "memory" service (single-handler dispatch). */
export type MemoryCommand =
  | { op: "remember"; input: MemoryInput }
  | { op: "search"; query: string; options?: SearchOptions }
  | { op: "recent"; kind?: MemoryKind; limit?: number }
  | { op: "forget"; id: string };
