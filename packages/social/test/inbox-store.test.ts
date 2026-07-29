import { describe, it, expect } from "vitest";
import { newItems, markAutoReplied, markPendingApproval, type InboxItem } from "../src/inbox-store";

function item(externalId: string): Omit<InboxItem, "id" | "createdAt" | "status"> {
  return { accountId: "a1", kind: "comment", externalId, fromUsername: "user1", text: "hi", draftReply: "thanks!", confidence: 95 };
}

describe("newItems", () => {
  it("excludes anything whose externalId already exists in the store", () => {
    const existing: InboxItem[] = [{ ...item("c1"), id: "i1", status: "auto_replied", createdAt: "t" } as InboxItem];
    const candidates = [item("c1"), item("c2")];
    const fresh = newItems(candidates, existing);
    expect(fresh.map((i) => i.externalId)).toEqual(["c2"]);
  });
});

describe("markAutoReplied / markPendingApproval", () => {
  it("adds a new item with status auto_replied", () => {
    const result = markAutoReplied([], item("c1"));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ externalId: "c1", status: "auto_replied" });
    expect(result[0]!.id).toBeTruthy();
  });

  it("adds a new item with status pending_approval", () => {
    const result = markPendingApproval([], item("c1"));
    expect(result[0]).toMatchObject({ externalId: "c1", status: "pending_approval" });
  });
});
