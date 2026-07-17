import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Audit Log — "every decision is logged" (core principle #3).
 *
 * Every action a plugin attempts, every event it emits, every secret it
 * requests, and every Guardian decision flows through here. The sink is
 * pluggable: today it's in-memory or a JSON file — later it can become
 * Postgres — callers never change.
 *
 * Beyond audit trail duty, this doubles as ATLAS's run ledger: a "run" is a
 * matched pair of entries sharing the same `id` — one with `status: "running"`
 * written before a handler executes, one with `status: "done"` or `"failed"`
 * written after. Not every entry is part of a run (e.g. `secret:` and
 * `provide:` entries are single, unpaired log lines) — `status` is only set
 * on entries that represent a trackable run.
 */
export interface AuditEntry {
  /** Present when this entry is (half of) a trackable run; absent for one-off log lines. */
  id?: string;
  timestamp: string;
  /** Who acted: a plugin name, or "kernel"/"owner-console". */
  actor: string;
  /** What was attempted, e.g. "emit:video.rendered" or "invoke:cfo". */
  action: string;
  /** The Guardian's verdict. */
  decision: "allow" | "deny" | "pending";
  /** Result summary or the reason for a deny/pending. */
  outcome?: string;
  metadata?: Record<string, unknown>;
  /** Run lifecycle state — only set on entries that are half of a run pair. */
  status?: "running" | "done" | "failed";
  /** Set on the completion entry of a run. */
  endedAt?: string;
  /** Set on the completion entry of a run. */
  durationMs?: number;
  /** Set on the completion entry of a run that failed. */
  error?: string;
}

export interface AuditSink {
  write(entry: AuditEntry): void | Promise<void>;
  /** Read back everything written so far, in insertion order. */
  readAll(): AuditEntry[] | Promise<AuditEntry[]>;
}

/** Default sink. Swap for a Postgres sink later without touching callers. */
export class MemoryAuditSink implements AuditSink {
  readonly entries: AuditEntry[] = [];
  write(entry: AuditEntry): void {
    this.entries.push(entry);
  }
  readAll(): AuditEntry[] {
    return this.entries;
  }
}

/**
 * JSON-file sink — real persistence with no database, same philosophy as
 * `JsonFileStore` in `@atlas/memory` (that file is the reference pattern this
 * mirrors). Cache loads lazily on first access; every write re-persists the
 * whole array. Fine for ATLAS's single-owner, low-volume run counts — a
 * Postgres sink can replace this later without touching any caller.
 */
export class JsonFileAuditSink implements AuditSink {
  private cache: AuditEntry[] | null = null;

  constructor(private file: string) {}

  private load(): AuditEntry[] {
    if (this.cache) return this.cache;
    try {
      const raw = readFileSync(this.file, "utf8");
      this.cache = JSON.parse(raw) as AuditEntry[];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.cache ?? [], null, 2), "utf8");
  }

  write(entry: AuditEntry): void {
    const all = this.load();
    all.push(entry);
    this.persist();
  }

  readAll(): AuditEntry[] {
    return [...this.load()];
  }
}

export interface AuditQuery {
  actor?: string;
  status?: AuditEntry["status"];
  since?: string;
  until?: string;
}

export class AuditLog {
  constructor(private sink: AuditSink = new MemoryAuditSink()) {}

  async record(entry: Omit<AuditEntry, "timestamp"> & { timestamp?: string }): Promise<AuditEntry> {
    const full: AuditEntry = { ...entry, timestamp: entry.timestamp ?? new Date().toISOString() };
    await this.sink.write(full);
    return full;
  }

  /** Introspection helper — only meaningful with the in-memory sink. */
  get entries(): readonly AuditEntry[] {
    return this.sink instanceof MemoryAuditSink ? this.sink.entries : [];
  }

  /**
   * Filter recorded entries. Always reads through `sink.readAll()` — every
   * `AuditSink` (in-memory or file-backed) must honestly implement that
   * method, so `query()` never needs to special-case or guess at a sink's
   * internal shape.
   */
  async query(filter: AuditQuery): Promise<AuditEntry[]> {
    const all = await this.sink.readAll();
    return all.filter((e) => {
      if (filter.actor && e.actor !== filter.actor) return false;
      if (filter.status && e.status !== filter.status) return false;
      if (filter.since && e.timestamp < filter.since) return false;
      if (filter.until && e.timestamp > filter.until) return false;
      return true;
    });
  }
}
