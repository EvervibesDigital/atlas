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

export function findDraft(drafts: IntroDraft[], id: string): IntroDraft | undefined {
  return drafts.find((d) => d.id === id || d.buyerId === id);
}

export function removeDraft(drafts: IntroDraft[], id: string): IntroDraft[] {
  return drafts.filter((d) => d.id !== id && d.buyerId !== id);
}
