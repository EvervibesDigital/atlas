import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { MemoryRecord, MemoryStore } from "./types";

/** Volatile store — used by tests and ephemeral runs. */
export class InMemoryStore implements MemoryStore {
  private records: MemoryRecord[] = [];

  async put(record: MemoryRecord): Promise<void> {
    const i = this.records.findIndex((r) => r.id === record.id);
    if (i >= 0) this.records[i] = record;
    else this.records.push(record);
  }
  async all(): Promise<MemoryRecord[]> {
    return [...this.records];
  }
  async delete(id: string): Promise<boolean> {
    const i = this.records.findIndex((r) => r.id === id);
    if (i < 0) return false;
    this.records.splice(i, 1);
    return true;
  }
}

/**
 * JSON-file store — real persistence with no database. Memory survives
 * restarts, works fully offline, and needs no Docker. This is ATLAS's default
 * so it "just runs". A Postgres+pgvector store implements the same interface
 * for scale later.
 */
export class JsonFileStore implements MemoryStore {
  private cache: MemoryRecord[] | null = null;

  constructor(private file: string) {}

  private async load(): Promise<MemoryRecord[]> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.file, "utf8");
      this.cache = JSON.parse(raw) as MemoryRecord[];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.cache ?? [], null, 2), "utf8");
  }

  async put(record: MemoryRecord): Promise<void> {
    const all = await this.load();
    const i = all.findIndex((r) => r.id === record.id);
    if (i >= 0) all[i] = record;
    else all.push(record);
    await this.persist();
  }
  async all(): Promise<MemoryRecord[]> {
    return [...(await this.load())];
  }
  async delete(id: string): Promise<boolean> {
    const all = await this.load();
    const i = all.findIndex((r) => r.id === id);
    if (i < 0) return false;
    all.splice(i, 1);
    await this.persist();
    return true;
  }
}
