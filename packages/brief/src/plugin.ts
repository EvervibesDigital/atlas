import type { Plugin } from "@atlas/core";
import type { BriefCommand, BriefItem, BriefSource } from "./types";

/**
 * Brief plugin (service "brief") — the Unified Morning Brief. Every business
 * ATLAS runs (KDP, Gig Finder, the generic Approval Gateway, and whatever
 * else files into "approvals" going forward) files its pending items here
 * into ONE list. Mat approves or rejects each item from one place instead of
 * checking five separate tabs.
 *
 * This does NOT introduce a new approval mechanism — it reads each source's
 * own existing pending state (kdp books awaiting upload, gigfinder's "new"
 * queue, the approvals gateway's "pending" list) and, on "act", calls back
 * into that SAME source's existing op to resolve it. No new write paths, no
 * new risk: the brief is a read+dispatch layer over what's already built.
 *
 * A source that errors (not configured, momentarily down) is skipped rather
 * than failing the whole brief — Mat should still see today's KDP books even
 * if, say, the gigfinder search key isn't set.
 */
export function createBriefPlugin(): Plugin {
  return {
    manifest: {
      name: "brief",
      version: "0.1.0",
      capabilities: ["brief"],
      permissions: ["call:kdp", "call:gigfinder", "call:approvals"],
      role: "executor",
    },

    register(ctx) {
      async function fromKdp(): Promise<BriefItem[]> {
        const status = (await ctx.call("kdp", { op: "status" })) as { books?: Array<{ id: string; title?: string | null; niche: string; status: string; created_at: string }> };
        return (status.books ?? [])
          .filter((b) => b.status === "generated")
          .map((b) => ({
            id: b.id,
            source: "kdp" as const,
            title: b.title ?? `Untitled ${b.niche} book`,
            detail: "Ready to download and upload to Amazon KDP.",
            risk: 0 as const,
            createdAt: b.created_at,
          }));
      }

      async function fromGigFinder(): Promise<BriefItem[]> {
        const gigs = (await ctx.call("gigfinder", { op: "list", status: "new" })) as Array<{ id: string; title: string; snippet: string; foundAt: string; budget?: number }>;
        return gigs.map((g) => ({
          id: g.id,
          source: "gigfinder" as const,
          title: g.title,
          detail: g.budget ? `${g.snippet} (budget: $${g.budget})` : g.snippet,
          risk: 0 as const,
          createdAt: g.foundAt,
        }));
      }

      async function fromApprovals(): Promise<BriefItem[]> {
        const approvals = (await ctx.call("approvals", { op: "list", status: "pending" })) as Array<{ id: string; action: string; detail?: string; risk: number; createdAt: string }>;
        return approvals.map((a) => ({
          id: a.id,
          source: "approvals" as const,
          title: a.action,
          detail: a.detail,
          risk: a.risk as BriefItem["risk"],
          createdAt: a.createdAt,
        }));
      }

      async function collect(fn: () => Promise<BriefItem[]>): Promise<BriefItem[]> {
        try {
          return await fn();
        } catch {
          return [];
        }
      }

      ctx.provide("brief", async (payload) => {
        const cmd = payload as BriefCommand;

        if (cmd.op === "today") {
          const [kdp, gigfinder, approvals] = await Promise.all([collect(fromKdp), collect(fromGigFinder), collect(fromApprovals)]);
          const items = [...kdp, ...gigfinder, ...approvals].sort((a, b) => b.risk - a.risk || (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
          return { items, count: items.length };
        }

        if (cmd.op === "act") {
          const { source, id, action } = cmd;
          if (source === "kdp") {
            return ctx.call("kdp", { op: "markStatus", id, status: action === "approve" ? "downloaded" : "archived" });
          }
          if (source === "gigfinder") {
            return ctx.call("gigfinder", { op: action === "approve" ? "approve" : "reject", id });
          }
          if (source === "approvals") {
            return ctx.call("approvals", { op: action === "approve" ? "approve" : "reject", id });
          }
          throw new Error(`brief: unknown source "${source as BriefSource}"`);
        }

        throw new Error(`brief: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
