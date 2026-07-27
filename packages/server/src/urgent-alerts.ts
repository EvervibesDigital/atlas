/**
 * Pure helpers for the "ATLAS found something during the hourly loop that
 * needs your call" alert — separate from the once-daily morning digest.
 * Only "ask"-tier brief items qualify (money/phone/contacting-a-specific-
 * person — see @atlas/brief's tier docs), and only once per item: the caller
 * persists `alertKey(item)` for everything already sent so the same stuck
 * item doesn't re-email every hour it sits unapproved.
 */

export interface AlertableItem {
  source: string;
  id: string;
  title: string;
  detail?: string;
  tier: string;
}

/** Stable dedupe key for one item — source alone isn't unique, id alone isn't
 * either (different sources can reuse the same id shape). */
export function alertKey(item: { source: string; id: string }): string {
  return `${item.source}:${item.id}`;
}

/** Ask-tier items not already covered by a previous alert. */
export function findNewUrgentItems(items: AlertableItem[], alreadyAlerted: ReadonlySet<string>): AlertableItem[] {
  return items.filter((i) => i.tier === "ask" && !alreadyAlerted.has(alertKey(i)));
}

export function buildUrgentAlertEmail(items: AlertableItem[]): { subject: string; body: string } {
  const subject = items.length === 1
    ? `🔔 ATLAS needs your input: ${items[0]!.title}`
    : `🔔 ATLAS found ${items.length} things needing your input`;
  const lines = [
    `ATLAS found ${items.length} new thing${items.length === 1 ? "" : "s"} during its hourly check that need${items.length === 1 ? "s" : ""} your call before it can go further:`,
    ``,
    ...items.map((i) => `• [${i.source}] ${i.title}${i.detail ? ` — ${i.detail}` : ""}`),
    ``,
    `This is separate from your daily morning brief — check it any time, no need to wait.`,
    `— ATLAS`,
  ];
  return { subject, body: lines.join("\n") };
}
