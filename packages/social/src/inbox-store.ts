import { randomUUID } from "node:crypto";

export interface InboxItem {
  id: string;
  accountId: string;
  kind: "comment" | "dm";
  externalId: string;
  fromUsername: string;
  text: string;
  draftReply: string;
  confidence: number;
  status: "auto_replied" | "pending_approval" | "approved" | "rejected";
  createdAt: string;
}

export type NewInboxItem = Omit<InboxItem, "id" | "status" | "createdAt">;

/** Candidates not already represented in the store, by externalId (Meta's
 * comment/message id — stable, dedupes across repeated polls). */
export function newItems(candidates: NewInboxItem[], existing: InboxItem[]): NewInboxItem[] {
  const seen = new Set(existing.map((i) => i.externalId));
  return candidates.filter((c) => !seen.has(c.externalId));
}

export function markAutoReplied(items: InboxItem[], newItem: NewInboxItem): InboxItem[] {
  return [...items, { ...newItem, id: randomUUID(), status: "auto_replied" as const, createdAt: new Date().toISOString() }];
}

export function markPendingApproval(items: InboxItem[], newItem: NewInboxItem): InboxItem[] {
  return [...items, { ...newItem, id: randomUUID(), status: "pending_approval" as const, createdAt: new Date().toISOString() }];
}
