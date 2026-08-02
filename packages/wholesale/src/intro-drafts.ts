export interface IntroDraft {
  /** Brief-routable id, always `intro:<buyerId>`. The prefix is how the Brief
   * tells an intro draft apart from a wholesale pending-action, without
   * needing a new BriefSource and a change to every UI switch. */
  id: string;
  buyerId: string;
  name: string;
  email: string;
  subject: string;
  body: string;
  createdAt: string;
}

export const INTRO_DRAFT_PREFIX = "intro:";

export function introDraftId(buyerId: string): string {
  return `${INTRO_DRAFT_PREFIX}${buyerId}`;
}

export function isIntroDraftId(id: string): boolean {
  return id.startsWith(INTRO_DRAFT_PREFIX);
}

/**
 * Merge freshly-previewed drafts into the stored set, replacing any existing
 * draft for the same buyer.
 *
 * Persistence is the whole point of this module. The intro copy is AI-written
 * per buyer, so calling preview twice produces DIFFERENT text — meaning an
 * approved draft and the email actually sent could differ, which silently
 * defeats the purpose of approving wording at all. Storing the draft at
 * preview time and sending that exact stored text is what makes "approve this
 * email" literally true.
 */
export function storeDrafts(
  existing: IntroDraft[],
  incoming: Array<{ id: string; name?: string; email?: string; subject: string; body: string }>,
  now: () => string = () => new Date().toISOString(),
): IntroDraft[] {
  const out = [...existing];
  for (const d of incoming) {
    if (!d?.id || !d.subject || !d.body) continue;
    const buyerId = String(d.id);
    const draft: IntroDraft = {
      id: introDraftId(buyerId),
      buyerId,
      name: d.name ?? "",
      email: d.email ?? "",
      subject: d.subject,
      body: d.body,
      createdAt: now(),
    };
    const at = out.findIndex((x) => x.buyerId === buyerId);
    if (at >= 0) out[at] = draft;
    else out.push(draft);
  }
  return out;
}

/**
 * Ensure a stored intro carries the two things US commercial email must have:
 * a physical postal address and a way to opt out.
 *
 * The evervibes send-intro endpoint appends its own footer server-side, so a
 * draft returned from `preview` has neither. Routing wholesale through
 * `sender` — which refuses without both — means the footer has to be added
 * here instead. That refusal is the point: `sender` is only a meaningful
 * safety boundary if there is no second path around it, and wholesale sending
 * through evervibes would have skipped the suppression list entirely. Someone
 * who opted out of compliance email could still have received a wholesale
 * intro.
 *
 * Idempotent — an address already present is not duplicated, so re-drafting
 * the same buyer twice cannot stack footers.
 */
export function withComplianceFooter(body: string, postalAddress: string, optOut?: string): string {
  const text = (body ?? "").trimEnd();
  const optOutLine = (optOut ?? "").trim() || "If this isn't useful, just say so and I won't follow up.";
  const parts = [text];
  if (!text.includes(optOutLine)) parts.push(optOutLine);
  if (!text.includes(postalAddress.trim())) parts.push(postalAddress.trim());
  return parts.join("\n\n");
}

export function findDraft(drafts: IntroDraft[], id: string): IntroDraft | undefined {
  return drafts.find((d) => d.id === id || d.buyerId === id);
}

export function removeDraft(drafts: IntroDraft[], id: string): IntroDraft[] {
  return drafts.filter((d) => d.id !== id && d.buyerId !== id);
}
