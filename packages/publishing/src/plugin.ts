import type { Plugin } from "@atlas/core";
import type { Approval } from "@atlas/approvals";
import type { PublishCommand, PublishInput, PublishResult } from "./types";
import { validateForInstagram } from "./instagram";
import { DryRunPublisher, type Publisher } from "./publisher";

/**
 * Publishing plugin — exposes the "publishing" service for Instagram Reels.
 *
 * Flow (nothing posts without human approval):
 *   publish → validate → request approval (risk L2) → returns pending-approval
 *   ...later... approval.granted → run the Publisher (dry-run by default)
 *                                → emit reel.published
 *
 * The default Publisher is DryRunPublisher, so ATLAS is fully wired to post but
 * posts nothing until a live publisher is injected here.
 */
export function createPublishingPlugin(opts: { publisher?: Publisher } = {}): Plugin {
  const publisher = opts.publisher ?? new DryRunPublisher();

  return {
    manifest: {
      name: "publishing",
      version: "0.1.0",
      capabilities: ["publishing"],
      permissions: ["call:approvals"],
      role: "executor",
    },

    register(ctx) {
      // Pending posts, keyed by the approval they're waiting on.
      const jobs = new Map<string, PublishInput>();

      // When Mat approves, run the publisher for the matching job.
      ctx.on("approval.granted", async (payload) => {
        const approval = payload as Approval;
        const job = jobs.get(approval.id);
        if (!job) return;
        jobs.delete(approval.id);
        const result = await publisher.publish(job);
        await ctx.emit("reel.published", { approvalId: approval.id, result, personaHandle: job.personaHandle });
      });

      ctx.provide("publishing", async (payload) => {
        const cmd = payload as PublishCommand;

        if (cmd.op === "validate") {
          const check = validateForInstagram(cmd.input);
          return { status: check.ok ? "dry-run" : "rejected", detail: check.problems.join("; ") || "valid" } satisfies PublishResult;
        }

        if (cmd.op === "publish") {
          const check = validateForInstagram(cmd.input);
          if (!check.ok) return { status: "rejected", detail: check.problems.join("; ") } satisfies PublishResult;
          if (!cmd.input.videoRef) return { status: "pending-render", detail: "no rendered MP4 yet" } satisfies PublishResult;

          const approval = (await ctx.call("approvals", {
            op: "request",
            action: `Post Reel to Instagram (${cmd.input.personaHandle})`,
            detail: cmd.input.caption.slice(0, 120),
            risk: 2,
          })) as Approval;

          jobs.set(approval.id, cmd.input);
          return { status: "pending-approval", detail: `awaiting approval ${approval.id}`, approvalId: approval.id } satisfies PublishResult;
        }

        throw new Error(`publishing: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
