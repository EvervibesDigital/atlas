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
      permissions: ["call:kdp", "call:gigfinder", "call:approvals", "call:surplus", "call:wholesale", "call:leadscan", "call:learning"],
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
        const gigs = (await ctx.call("gigfinder", { op: "list", status: "new" })) as Array<{ id: string; title: string; snippet: string; foundAt: string; budget?: number; draftBid?: string }>;
        return gigs.map((g) => ({
          id: g.id,
          source: "gigfinder" as const,
          title: g.title,
          detail: `${g.budget ? `${g.snippet} (budget: $${g.budget})` : g.snippet}${g.draftBid ? " — pitch already drafted, ready to copy" : ""}`,
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

      type SurplusLeadLike = { lead_id?: string; case_number?: string; owner_name?: string; property_address?: string; county?: string; state?: string; estimated_surplus?: number };

      function surplusLeadId(lead: SurplusLeadLike): string {
        return lead.lead_id ?? lead.case_number ?? "";
      }

      async function fromSurplus(): Promise<BriefItem[]> {
        const res = (await ctx.call("surplus", { op: "pendingLeads" })) as { leads?: SurplusLeadLike[] };
        return (res.leads ?? []).map((lead) => ({
          id: surplusLeadId(lead),
          source: "surplus" as const,
          title: `${lead.owner_name ?? "Unknown owner"} — ${lead.property_address ?? "address unknown"}`,
          detail: `Est. surplus $${(lead.estimated_surplus ?? 0).toLocaleString()} (${[lead.county, lead.state].filter(Boolean).join(", ")}). Approving triggers real outreach to this person.`,
          risk: 1 as const,
        }));
      }

      const WHOLESALE_LABEL: Record<string, string> = {
        deal_blast: "Blast deal to matched buyers",
        sms_deal_alert: "SMS deal alert",
        bland_call: "Bland verification call",
        outreach_email: "Investor outreach email",
      };

      async function fromWholesale(): Promise<BriefItem[]> {
        const res = (await ctx.call("wholesale", { op: "list" })) as { actions?: Array<{ id: string; action_type: string; roi_score: number; target_count: number; target_summary: string | null; reason: string | null; created_at: string }> };
        return (res.actions ?? []).map((a) => ({
          id: a.id,
          source: "wholesale" as const,
          title: `${WHOLESALE_LABEL[a.action_type] ?? a.action_type}${a.target_summary ? ` — ${a.target_summary}` : ""}`,
          detail: `${a.reason ?? ""}${a.roi_score ? ` (~$${a.roi_score.toLocaleString()} at stake)` : ""}`.trim() || undefined,
          risk: (a.roi_score >= 5000 ? 2 : 1) as BriefItem["risk"],
          createdAt: a.created_at,
        }));
      }

      async function fromLeadscan(): Promise<BriefItem[]> {
        const leads = (await ctx.call("leadscan", { op: "list", status: "new" })) as Array<{ id: string; businessName: string; website: string; niche: string; city: string; foundAt: string; scan?: { overallScore: number; issues: Array<{ issue: string }> } }>;
        return leads.map((l) => ({
          id: l.id,
          source: "leadscan" as const,
          title: `${l.businessName} — ${l.website}`,
          detail: l.scan
            ? `Score ${l.scan.overallScore}/100 — ${l.scan.issues.slice(0, 2).map((i) => i.issue).join("; ") || "no issues found"}. Approving emails this business.`
            : `${l.niche} in ${l.city}. Approving emails this business.`,
          risk: 1 as const,
          createdAt: l.foundAt,
        }));
      }

      async function fromLearning(): Promise<BriefItem[]> {
        const proposals = (await ctx.call("learning", { op: "proposals" })) as Array<{ id: string; category: string; problem: string; suggestion: string; createdAt: string }>;
        return proposals.map((p) => ({
          id: p.id,
          source: "learning" as const,
          title: `ATLAS proposal: ${p.category}`,
          detail: `${p.problem} ${p.suggestion}`,
          risk: 0 as const,
          createdAt: p.createdAt,
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
          const [kdp, gigfinder, approvals, surplus, wholesale, leadscan, learning] = await Promise.all([
            collect(fromKdp),
            collect(fromGigFinder),
            collect(fromApprovals),
            collect(fromSurplus),
            collect(fromWholesale),
            collect(fromLeadscan),
            collect(fromLearning),
          ]);
          const items = [...kdp, ...gigfinder, ...approvals, ...surplus, ...wholesale, ...leadscan, ...learning].sort((a, b) => b.risk - a.risk || (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
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
          if (source === "surplus") {
            if (action === "reject") return { skipped: id };
            const res = (await ctx.call("surplus", { op: "pendingLeads" })) as { leads?: SurplusLeadLike[] };
            const lead = (res.leads ?? []).find((l) => surplusLeadId(l) === id);
            if (!lead) throw new Error(`brief: surplus lead "${id}" not found (it may have already been handled)`);
            const message = `Reach out to ${lead.owner_name ?? "the property owner"} regarding case ${lead.case_number ?? id}, property ${lead.property_address ?? "unknown address"}, estimated surplus $${(lead.estimated_surplus ?? 0).toLocaleString()}.`;
            return ctx.call("surplus", { op: "run", role: "outreach", message });
          }
          if (source === "wholesale") {
            return ctx.call("wholesale", action === "approve" ? { op: "approve", id } : { op: "veto", id, reason: "atlas_brief_reject" });
          }
          if (source === "leadscan") {
            return ctx.call("leadscan", { op: action === "approve" ? "approve" : "reject", id });
          }
          if (source === "learning") {
            // id IS the category (see fromLearning/proposals.ts) — proposals
            // are recomputed live from metrics, so there's no record to fetch
            // by a separate id, only a category to adopt or dismiss.
            return ctx.call("learning", { op: action === "approve" ? "adopt" : "dismiss", category: id });
          }
          throw new Error(`brief: unknown source "${source as BriefSource}"`);
        }

        throw new Error(`brief: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
