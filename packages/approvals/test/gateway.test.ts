import { describe, it, expect } from "vitest";
import { ApprovalGateway } from "../src/gateway";

describe("ApprovalGateway", () => {
  it("creates a pending approval", async () => {
    const g = new ApprovalGateway();
    const a = await g.request({ action: "Post to TikTok", risk: 2 });
    expect(a.status).toBe("pending");
    expect(a.id).toBeTruthy();
  });

  it("lists by status", async () => {
    const g = new ApprovalGateway();
    await g.request({ action: "one", risk: 2 });
    const b = await g.request({ action: "two", risk: 3 });
    await g.decide(b.id, "approved");
    expect(await g.list("pending")).toHaveLength(1);
    expect(await g.list("approved")).toHaveLength(1);
  });

  it("approves and rejects only pending items", async () => {
    const g = new ApprovalGateway();
    const a = await g.request({ action: "spend money", risk: 3 });
    const approved = await g.decide(a.id, "approved");
    expect(approved?.status).toBe("approved");
    expect(approved?.decidedAt).toBeTruthy();
    // Deciding again is a no-op (already decided).
    expect(await g.decide(a.id, "rejected")).toBeUndefined();
  });

  it("returns undefined for an unknown id", async () => {
    const g = new ApprovalGateway();
    expect(await g.decide("nope", "approved")).toBeUndefined();
  });
});
