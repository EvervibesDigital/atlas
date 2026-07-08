/**
 * Audit Log — "every decision is logged" (core principle #3).
 *
 * Every action a plugin attempts, every event it emits, every secret it
 * requests, and every Guardian decision flows through here. The sink is
 * pluggable: today it's in-memory, later it becomes Postgres — callers never
 * change.
 */
export interface AuditEntry {
  timestamp: string;
  /** Who acted: a plugin name, or "kernel". */
  actor: string;
  /** What was attempted, e.g. "emit:video.rendered" or "purchase". */
  action: string;
  /** The Guardian's verdict. */
  decision: "allow" | "deny" | "pending";
  /** Result summary or the reason for a deny/pending. */
  outcome?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditSink {
  write(entry: AuditEntry): void | Promise<void>;
}

/** Default sink. Swap for a Postgres sink later without touching callers. */
export class MemoryAuditSink implements AuditSink {
  readonly entries: AuditEntry[] = [];
  write(entry: AuditEntry): void {
    this.entries.push(entry);
  }
}

export class AuditLog {
  constructor(private sink: AuditSink = new MemoryAuditSink()) {}

  async record(entry: Omit<AuditEntry, "timestamp">): Promise<AuditEntry> {
    const full: AuditEntry = { ...entry, timestamp: new Date().toISOString() };
    await this.sink.write(full);
    return full;
  }

  /** Introspection helper — only meaningful with the in-memory sink. */
  get entries(): readonly AuditEntry[] {
    return this.sink instanceof MemoryAuditSink ? this.sink.entries : [];
  }
}
