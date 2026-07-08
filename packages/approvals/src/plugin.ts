import type { Plugin } from "@atlas/core";
import type { ApprovalCommand } from "./types";
import { ApprovalGateway } from "./gateway";

/**
 * Approval Gateway plugin — exposes the "approvals" service. On a resolved
 * decision it emits `approval.granted` / `approval.rejected` so executor
 * plugins can act (or stand down). This is core principle #5 in practice:
 * human approval overrides AI.
 */
export function createApprovalsPlugin(opts: { gateway?: ApprovalGateway; file?: string } = {}): Plugin {
  return {
    manifest: {
      name: "approvals",
      version: "0.1.0",
      capabilities: ["approvals"],
      permissions: [],
      role: "policy",
    },

    async register(ctx) {
      const gateway = opts.gateway ?? new ApprovalGateway(opts.file ?? ctx.config("APPROVALS_FILE") ?? "./data/approvals.json");

      ctx.provide("approvals", async (payload) => {
        const cmd = payload as ApprovalCommand;
        switch (cmd.op) {
          case "request":
            return gateway.request({ action: cmd.action, detail: cmd.detail, risk: cmd.risk });
          case "list":
            return gateway.list(cmd.status);
          case "approve": {
            const approval = await gateway.decide(cmd.id, "approved");
            if (approval) await ctx.emit("approval.granted", approval);
            return approval;
          }
          case "reject": {
            const approval = await gateway.decide(cmd.id, "rejected");
            if (approval) await ctx.emit("approval.rejected", approval);
            return approval;
          }
          default:
            throw new Error(`approvals: unknown op "${(cmd as { op: string }).op}"`);
        }
      });
    },
  };
}
