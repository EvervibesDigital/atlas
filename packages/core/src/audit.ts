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
   * Filter recorded entries. Synchronous against whatever the sink currently
   * has cached — sinks that lazy-load from disk populate their cache on the
   * first `write()`/`read()`, same as `JsonFileStore` in `@atlas/memory`.
   */
  query(filter: AuditQuery): AuditEntry[] {
    const all = this.sink instanceof MemoryAuditSink ? this.sink.entries : (this.sink as { cached?: AuditEntry[] }).cached ?? [];
    return all.filter((e) => {
      if (filter.actor && e.actor !== filter.actor) return false;
      if (filter.status && e.status !== filter.status) return false;
      if (filter.since && e.timestamp < filter.since) return false;
      if (filter.until && e.timestamp > filter.until) return false;
      return true;
    });
  }
}
