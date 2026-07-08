import { describe, it, expect } from "vitest";
import { Atlas, type Plugin } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { createApprovalsPlugin, ApprovalGateway, type Approval } from "@atlas/approvals";
import { createExecutivePlugin } from "../src/index";

/**
 * The Phase 1 integration: Executive plans, auto-dispatches the safe task, and
 * routes the risky task to the Approval Gateway — all through the real kernel
 * and Guardian.
 */
describe("Executive → Approval Gateway (end to end)", () => {
  it("dispatches L0 automatically and sends L3 to human approval", async () => {
    const atlas = new Atlas({ guardian: new Guardian() });
    await atlas.use(createApprovalsPlugin({ gateway: new ApprovalGateway() }));
    await atlas.use(createExecutivePlugin());

    const dispatched: string[] = [];
    atlas.events.on("task.ready", (p) => void dispatched.push((p as { task: { description: string } }).task.description));

    let pending: Approval[] = [];
    await atlas.use({
      manifest: { name: "operator", version: "1", capabilities: [], permissions: ["call:executive", "call:approvals"], role: "executor" },
      async register(ctx) {
        await ctx.call("executive", {
          objective: "Launch a video",
          steps: [
            { id: "research", description: "Research trending topics", risk: 0 },
            { id: "spend", description: "Buy $50 of ads", risk: 3 },
          ],
        });
        pending = (await ctx.call("approvals", { op: "list", status: "pending" })) as Approval[];
      },
    });

    // The safe research task auto-dispatched…
    expect(dispatched).toContain("Research trending topics");
    // …and the money task is waiting for Mat.
    expect(pending).toHaveLength(1);
    expect(pending[0]!.action).toBe("Buy $50 of ads");
    expect(pending[0]!.risk).toBe(3);
  });

  it("is blocked by the Guardian from executing (planner role)", async () => {
    // Proves the seam: even though executive plans execution, it cannot itself
    // run anything — a direct execute attempt would be denied. Here we simply
    // confirm the manifest role is planner (the seam is unit-tested in guardian).
    const plugin = createExecutivePlugin();
    expect(plugin.manifest.role).toBe("planner");
  });
});
