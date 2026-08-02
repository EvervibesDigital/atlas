import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * The do-not-contact list.
 *
 * An opt-out has to be permanent and it has to be enforced at the point of
 * sending, not by whoever happens to be calling. Leaving the check to callers
 * means the one code path that forgets is the one that mails somebody who
 * already asked to be left alone — and that person has no way to ask twice.
 *
 * Deliberately a plain JSON file rather than a table: it must be readable and
 * editable by hand, because "take me off your list" sometimes arrives as a
 * reply to Mat personally rather than through any system.
 */

export interface SuppressionEntry {
  email: string;
  reason: string;
  at: string;
}

/**
 * Addresses are compared in a normalized form so an opt-out cannot be defeated
 * by capitalisation or a plus-tag. `Bob+news@Gmail.com` and `bob@gmail.com` are
 * the same inbox, and someone who unsubscribed from one has unsubscribed from
 * both. Gmail also ignores dots in the local part, so those go too — this
 * over-suppresses slightly on non-Gmail hosts, which is the right direction to
 * be wrong in.
 */
export function normalizeEmail(email: string): string {
  const trimmed = (email ?? "").trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at < 1) return trimmed;
  let local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}

export async function loadSuppressions(file: string): Promise<SuppressionEntry[]> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SuppressionEntry[]) : [];
  } catch {
    // No file yet, or unreadable. An empty list is correct for "nobody has
    // opted out"; a corrupt file is handled by isSuppressed's caller, which
    // fails the send rather than proceeding blind (see plugin.ts).
    return [];
  }
}

export async function saveSuppressions(file: string, entries: SuppressionEntry[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(entries, null, 2), "utf8");
}

export function isSuppressed(entries: SuppressionEntry[], email: string): boolean {
  const target = normalizeEmail(email);
  return entries.some((e) => normalizeEmail(e.email) === target);
}

/** Adds an address, or returns the list unchanged if it's already there. */
export function addSuppression(entries: SuppressionEntry[], email: string, reason: string, now = new Date()): SuppressionEntry[] {
  if (isSuppressed(entries, email)) return entries;
  return [...entries, { email: email.trim(), reason: reason.trim() || "unspecified", at: now.toISOString() }];
}

/**
 * Splits recipients into those we may contact and those we may not.
 *
 * Returned rather than silently filtered, so a caller can report "3 of 10 were
 * suppressed" instead of quietly mailing 7 and leaving Mat to wonder where the
 * others went.
 */
export function partitionBySuppression<T extends { to: string }>(
  entries: SuppressionEntry[],
  recipients: T[],
): { allowed: T[]; suppressed: T[] } {
  const allowed: T[] = [];
  const suppressed: T[] = [];
  for (const r of recipients) (isSuppressed(entries, r.to) ? suppressed : allowed).push(r);
  return { allowed, suppressed };
}
