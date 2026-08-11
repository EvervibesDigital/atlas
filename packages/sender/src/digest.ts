import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * A record of every email that actually left ATLAS, and every one that was
 * considered and skipped — the daily digest Mat reads instead of a per-email
 * approval queue.
 *
 * Appended to on every real send attempt, by both the human-reviewed `send`
 * path and the unattended `sendAutonomous` path, so one file is the whole
 * history regardless of which path put an email on the wire.
 */
export interface DigestEntry {
  at: string;
  /** Which business originated this — "leadscan", "wholesale", or unset for
   * a manual send from the Health tab. */
  source?: string;
  to: string;
  subject: string;
  outcome: "sent" | "skipped" | "failed";
  /** Why, for a skip or failure. Absent for a clean send. */
  reason?: string;
}

export async function loadDigest(file: string): Promise<DigestEntry[]> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DigestEntry[]) : [];
  } catch {
    return [];
  }
}

export async function appendDigest(file: string, entries: DigestEntry[]): Promise<void> {
  if (!entries.length) return;
  const existing = await loadDigest(file);
  const combined = [...existing, ...entries];
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(combined, null, 2), "utf8");
}

/** Midnight-to-midnight in the given IANA zone, default UTC — so "today" means
 * the same thing regardless of what time zone the process happens to run in. */
export function isSameDay(isoA: string, isoB: string, timeZone = "UTC"): boolean {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(new Date(isoA)) === fmt.format(new Date(isoB));
}

export interface DigestSummary {
  sent: number;
  skipped: number;
  failed: number;
  bySource: Record<string, number>;
  entries: DigestEntry[];
}

/** Summarise entries from a given day (default: today, UTC) for the digest panel. */
export function summarizeDigest(entries: DigestEntry[], forDate: string = new Date().toISOString(), timeZone = "UTC"): DigestSummary {
  const todays = entries.filter((e) => isSameDay(e.at, forDate, timeZone));
  const bySource: Record<string, number> = {};
  let sent = 0, skipped = 0, failed = 0;
  for (const e of todays) {
    if (e.outcome === "sent") { sent++; bySource[e.source ?? "manual"] = (bySource[e.source ?? "manual"] ?? 0) + 1; }
    else if (e.outcome === "skipped") skipped++;
    else failed++;
  }
  return { sent, skipped, failed, bySource, entries: todays };
}
