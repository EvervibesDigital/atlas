import type { Plugin } from "@atlas/core";
import { needsApproval } from "@atlas/core";
import type { StepInput } from "./types";
import { Executive } from "./executive";

/**
 * Executive plugin — exposes the "executive" service. Given an objective +
 * steps it builds an ordered Plan, then for each ready task either:
 *   • auto-dispatches (emits `task.ready`) when risk ≤ L1, or
 *   • routes to the Approval Gateway (calls "approvals") when risk ≥ L2.
 *
 * It is a `planner`: the Guardian guarantees it can never execute a task
 * itself — it only plans and delegates.
 */
export function createExecutivePlugin(opts: { executive?: Executive } = {}): Plugin {
  return {
    manifest: {
      name: "executive",
      version: "0.1.0",
      capabilities: ["executive"],
      permissions: ["call:approvals"],
      role: "planner",
    },

    async register(ctx) {
      const executive = opts.executive ?? new Executive();

      ctx.provide("executive", async (payload) => {
        const { objective, steps } = payload as { objective: string; steps: StepInput[] };
        const plan = executive.decompose(objective, steps);
        await ctx.emit("executive.planned", { planId: plan.id, taskCount: plan.tasks.length });

        for (const task of executive.readyTasks(plan)) {
          if (needsApproval(task.risk)) {
            await ctx.call("approvals", {
              op: "request",
              action: task.description,
              detail: `plan ${plan.id}`,
              risk: task.risk,
            });
            task.status = "pending_approval";
          } else {
            await ctx.emit("task.ready", { planId: plan.id, task });
            task.status = "dispatched";
          }
        }
        return plan;
      });
    },
  };
}
