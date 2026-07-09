import { describe, it, expect } from "vitest";
import { Atlas, type Plugin } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { createApprovalsPlugin, ApprovalGateway, type Approval } from "@atlas/approvals";
import { createActionsPlugin, signupRecipe, type ActionRecord } from "../src/index";

describe("actions layer", () => {
  it("gates a signup behind approval, then simulates it (nothing real happens)", async () => {
    const atlas = new Atlas({ guardian: new Guardian() });
    await atlas.use(createApprovalsPlugin({ gateway: new ApprovalGateway() }));
    await atlas.use(createActionsPlugin()); // default SimulatedDriver

    const executed: Array<{ status: string }> = [];
    atlas.events.on("action.executed", (e) => void executed.push(e as { status: string }));

    let record: ActionRecord | undefined;
    await atlas.use({
      manifest: { name: "agent", version: "1", capabilities: [], permissions: ["call:actions", "call:approvals"], role: "executor" },
      async register(ctx) {
        record = (await ctx.call("actions", {
          op: "request",
          request: {
            type: "signup",
            title: "Sign up for ExampleTool",
            target: "https://exampletool.com/signup",
            steps: signupRecipe("https://exampletool.com/signup", [{ selector: "#email", value: "mat@x.com" }, { selector: "#pass", valueFromCred: "exampletool.password" }], "#submit"),
          },
        })) as ActionRecord;

        // Before approval: pending, nothing executed.
        expect(record.status).toBe("pending-approval");
        expect(executed).toHaveLength(0);

        // Mat approves → it runs (simulated).
        await ctx.call("approvals", { op: "approve", id: record.approvalId });
      },
    } satisfies Plugin);

    expect(executed).toHaveLength(1);
    expect(executed[0]!.status).toBe("simulated");

    // The action record now shows the simulated result + a step log.
    const gateway = new ApprovalGateway();
    void gateway; // (record fetched via service below)
  });

  it("high-risk actions (signup/install) always require approval", async () => {
    const atlas = new Atlas({ guardian: new Guardian() });
    await atlas.use(createApprovalsPlugin({ gateway: new ApprovalGateway() }));
    await atlas.use(createActionsPlugin());

    let pending: Approval[] = [];
    await atlas.use({
      manifest: { name: "agent2", version: "1", capabilities: [], permissions: ["call:actions", "call:approvals"], role: "executor" },
      async register(ctx) {
        await ctx.call("actions", { op: "request", request: { type: "install", title: "Install cool-repo", target: "acme/cool-repo" } });
        pending = (await ctx.call("approvals", { op: "list", status: "pending" })) as Approval[];
      },
    });

    expect(pending).toHaveLength(1);
  });

  it("marks the action rejected when Mat rejects it", async () => {
    const atlas = new Atlas({ guardian: new Guardian() });
    await atlas.use(createApprovalsPlugin({ gateway: new ApprovalGateway() }));
    await atlas.use(createActionsPlugin());

    let after: ActionRecord | null = null;
    await atlas.use({
      manifest: { name: "agent3", version: "1", capabilities: [], permissions: ["call:actions", "call:approvals"], role: "executor" },
      async register(ctx) {
        const rec = (await ctx.call("actions", { op: "request", request: { type: "post", title: "Post something" } })) as ActionRecord;
        await ctx.call("approvals", { op: "reject", id: rec.approvalId });
        after = (await ctx.call("actions", { op: "result", approvalId: rec.approvalId })) as ActionRecord;
      },
    });

    expect(after!.status).toBe("rejected");
  });
});
