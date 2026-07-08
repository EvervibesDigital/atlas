import { describe, it, expect } from "vitest";
import { Atlas, type Plugin } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { createApprovalsPlugin, ApprovalGateway, type Approval } from "../src/index";

describe("approvals plugin wired through the kernel", () => {
  it("requests, then approves, emitting approval.granted", async () => {
    const atlas = new Atlas({ guardian: new Guardian() });
    await atlas.use(createApprovalsPlugin({ gateway: new ApprovalGateway() }));

    const granted: Approval[] = [];
    atlas.events.on("approval.granted", (a) => void granted.push(a as Approval));

    let created: Approval | undefined;
    await atlas.use({
      manifest: { name: "ops", version: "1", capabilities: [], permissions: ["call:approvals"], role: "executor" },
      async register(ctx) {
        created = (await ctx.call("approvals", { op: "request", action: "Wire $500", risk: 3 })) as Approval;
        await ctx.call("approvals", { op: "approve", id: created.id });
      },
    });

    expect(created?.action).toBe("Wire $500");
    expect(granted).toHaveLength(1);
    expect(granted[0]!.status).toBe("approved");
  });
});
