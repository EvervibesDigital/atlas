import type { Plugin, AutonomyTier } from "@atlas/core";
import type { BriefCommand, BriefItem, BriefSource, BriefAction } from "./types";

/**
 * Brief plugin (service "brief") — the Unified Morning Brief AND the autonomy
 * router. Every business ATLAS runs files its pending items here into ONE
 * list, each tagged with an autonomy tier (see @atlas/core):
 *
 *   • "auto" items ATLAS acts on itself every cycle (op "autopilot") — only
 *     reversible/internal things (adopting a self-improvement proposal).
 *   • "bulk" items Mat clears a whole batch at once (op "actBulk") — outbound
 *     emails (lead outreach, investor emails, gig pitches). Batched approval,
 *     never auto-send.
 *   • "ask" items stay individual (op "act") — money, phone calls, contacting a
 *     specific distressed homeowner. Never batched, never auto.
 *
 * This does NOT introduce a new approval mechanism — it reads each source's own
 * existing pending state and, on any act, calls back into that SAME source's
 * existing op. No new write paths: the brief is a read+dispatch layer over
 * what's already built. A source that errors is skipped rather than failing
 * the whole brief.
 */
export function createBriefPlugin(): Plugin {
  return {
    manifest: {
      name: "brief",
      version: "0.1.0",
      capabilities: ["brief"],
      permissions: ["call:kdp", "call:gigfinder", "call:approvals", "call:surplus", "call:wholesale", "call:leadscan", "call:learning", "call:memory", "call:social", "call:mediaFactory"],
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
            // A real product Mat still has to download + upload to Amazon by
            // hand — individual, so it never disappears from the list before
            // he's actually grabbed it.
            tier: "ask" as const,
            createdAt: b.created_at,
          }));
      }

      async function fromGigFinder(): Promise<BriefItem[]> {
        const [newGigs, respondedGigs] = await Promise.all([
          ctx.call("gigfinder", { op: "list", status: "new" }) as Promise<Array<{ id: string; title: string; snippet: string; foundAt: string; budget?: number; draftBid?: string }>>,
          ctx.call("gigfinder", { op: "list", status: "responded" }) as Promise<Array<{ id: string; title: string; foundAt: string; notes?: string }>>,
        ]);
        const bidItems = newGigs.map((g) => ({
          id: g.id,
          source: "gigfinder" as const,
          title: g.title,
          detail: `${g.budget ? `${g.snippet} (budget: $${g.budget})` : g.snippet}${g.draftBid ? " — pitch already drafted, ready to copy" : ""}`,
          risk: 0 as const,
          // Approving only marks it approved + surfaces the already-drafted
          // pitch — it never auto-submits a bid (that boundary is permanent).
          // So batching "yes, these are worth pursuing" is safe.
          tier: "bulk" as const,
          createdAt: g.foundAt,
        }));
        const possibleWinItems = respondedGigs.map((g) => ({
          id: g.id,
          source: "gigfinder" as const,
          title: `Possible win: ${g.title}`,
          detail: g.notes ? `Client replied — review before ATLAS starts the work: "${g.notes.slice(0, 200)}"` : "Client replied — review before ATLAS starts the work.",
          risk: 1 as const,
          // Is this actually a win? A specific judgment call, same bar as a
          // reply to a specific person — never batched.
          tier: "ask" as const,
          createdAt: g.foundAt,
        }));
        return [...bidItems, ...possibleWinItems];
      }

      async function fromApprovals(): Promise<BriefItem[]> {
        const approvals = (await ctx.call("approvals", { op: "list", status: "pending" })) as Array<{ id: string; action: string; detail?: string; risk: number; createdAt: string }>;
        return approvals.map((a) => ({
          id: a.id,
          source: "approvals" as const,
          title: a.action,
          detail: a.detail,
          risk: a.risk as BriefItem["risk"],
          // The generic gateway carries its own risk; map it to a tier. Low
          // risk (0-1: e.g. "worth a look" repo scouting) batches; moderate/
          // high (2-3) stays individual.
          tier: (a.risk >= 2 ? "ask" : "bulk") as AutonomyTier,
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
          // Contacting a specific distressed homeowner — highest sensitivity,
          // always individual.
          tier: "ask" as const,
        }));
      }

      const WHOLESALE_LABEL: Record<string, string> = {
        deal_blast: "Blast deal to matched buyers",
        sms_deal_alert: "SMS deal alert",
        bland_call: "Bland verification call",
        outreach_email: "Investor outreach email",
      };

      async function fromWholesale(): Promise<BriefItem[]> {
        const res = (await ctx.call("wholesale", { op: "list" })) as {
          actions?: Array<{ id: string; action_type: string; roi_score: number; target_count: number; target_summary: string | null; reason: string | null; payload?: { kind?: string }; created_at: string }>;
        };
        return (res.actions ?? []).map((a) => {
          // The daily-engine wholesale flywheel's seller cold-outreach/follow-up
          // reuses action_type "outreach_email" (queued instead of auto-sent as
          // of 2026-07-26) — payload.kind distinguishes it from investor
          // outreach so the label doesn't lie about who's being emailed.
          const isSellerOutreach = a.action_type === "outreach_email" && a.payload?.kind === "seller";
          const label = isSellerOutreach ? "Seller outreach email" : (WHOLESALE_LABEL[a.action_type] ?? a.action_type);
          return {
            id: a.id,
            source: "wholesale" as const,
            title: `${label}${a.target_summary ? ` — ${a.target_summary}` : ""}`,
            detail: `${a.reason ?? ""}${a.roi_score ? ` (~$${a.roi_score.toLocaleString()} at stake)` : ""}`.trim() || undefined,
            risk: (a.roi_score >= 5000 ? 2 : 1) as BriefItem["risk"],
            // A single outbound email (seller or investor) batches with the
            // other emails; a mass buyer blast, an SMS, or a phone call stays
            // individual.
            tier: (a.action_type === "outreach_email" ? "bulk" : "ask") as AutonomyTier,
            createdAt: a.created_at,
          };
        });
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
          // Outbound cold email to a business — exactly the "bulk approvals for
          // emails" case: clear the batch in one tap, still reviewed, not auto.
          tier: "bulk" as const,
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
          // Adopting writes an advisory directive to ATLAS's OWN memory —
          // reversible, internal, touches no outside person or money. The one
          // genuinely safe auto: ATLAS improving itself unattended, the same
          // bar self-healing meets.
          tier: "auto" as const,
          createdAt: p.createdAt,
        }));
      }

      async function fromSocial(): Promise<BriefItem[]> {
        const items: BriefItem[] = [];

        const { accounts } = (await ctx.call("social", { op: "listAccounts" })) as { accounts: Array<{ id: string; personaLabel: string; platform: string }> };
        if (accounts.length > 0) {
          const creators = (await ctx.call("mediaFactory", { op: "listCreators" })) as Array<{ id: string; name: string }>;
          const allContent = (await ctx.call("mediaFactory", { op: "listContent" })) as Array<{ id: string; creator_id: string; status: string; caption?: string; assets?: { image_path?: string } }>;

          for (const account of accounts) {
            const creator = creators.find((c) => c.name === account.personaLabel);
            if (!creator) continue;
            const ready = allContent.filter((c) => c.creator_id === creator.id && c.status === "review" && c.assets?.image_path);
            if (ready.length === 0) continue;

            items.push({
              id: account.id,
              source: "social" as const,
              title: `${account.personaLabel} — ${ready.length} post${ready.length === 1 ? "" : "s"} ready`,
              detail: `Approving queues ${ready.length} post(s) to ${account.platform}, spread over the next 6 hours (not posted all at once).`,
              risk: 1 as const,
              // Posting AI-generated content live, batched like every other
              // outbound-content source (leadscan/wholesale email) — reviewed
              // per creator, one tap, never silently posted.
              tier: "bulk" as const,
            });
          }
        }

        const { items: pendingInbox } = (await ctx.call("social", { op: "listPendingInboxItems" })) as {
          items: Array<{ id: string; text: string; draftReply: string; fromUsername: string; kind: string }>;
        };
        for (const inboxItem of pendingInbox) {
          items.push({
            id: inboxItem.id,
            source: "social" as const,
            title: `Reply needed: "${inboxItem.text.slice(0, 60)}"`,
            detail: `Drafted reply: "${inboxItem.draftReply}" — low confidence, review before sending.`,
            risk: 1 as const,
            // A specific reply to a specific person — same bar as a phone
            // call, never batched with the "approve all" button.
            tier: "ask" as const,
          });
        }

        return items;
      }

      async function collect(fn: () => Promise<BriefItem[]>): Promise<BriefItem[]> {
        try {
          return await fn();
        } catch {
          return [];
        }
      }

      async function collectAll(): Promise<BriefItem[]> {
        const [kdp, gigfinder, approvals, surplus, wholesale, leadscan, learning, social] = await Promise.all([
          collect(fromKdp),
          collect(fromGigFinder),
          collect(fromApprovals),
          collect(fromSurplus),
          collect(fromWholesale),
          collect(fromLeadscan),
          collect(fromLearning),
          collect(fromSocial),
        ]);
        return [...kdp, ...gigfinder, ...approvals, ...surplus, ...wholesale, ...leadscan, ...learning, ...social].sort(
          (a, b) => b.risk - a.risk || (a.createdAt ?? "").localeCompare(b.createdAt ?? ""),
        );
      }

      /** Resolve ONE item back into its source's own op. Shared by act,
       * autopilot, and actBulk so every path goes through identical logic. */
      async function actOne(source: BriefSource, id: string, action: BriefAction): Promise<unknown> {
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
          // id IS the category (see fromLearning) — proposals are recomputed
          // live from metrics, so there's no record to fetch by a separate id.
          return ctx.call("learning", { op: action === "approve" ? "adopt" : "dismiss", category: id });
        }
        if (source === "social") {
          const { items: pendingInbox } = (await ctx.call("social", { op: "listPendingInboxItems" })) as { items: Array<{ id: string }> };
          if (pendingInbox.some((i) => i.id === id)) {
            return ctx.call("social", { op: "respondToInboxItem", id, action });
          }
          if (action === "reject") return { skipped: id };
          const { accounts } = (await ctx.call("social", { op: "listAccounts" })) as { accounts: Array<{ id: string; personaLabel: string }> };
          const account = accounts.find((a) => a.id === id);
          if (!account) throw new Error(`brief: social account "${id}" not found`);
          const creators = (await ctx.call("mediaFactory", { op: "listCreators" })) as Array<{ id: string; name: string }>;
          const creator = creators.find((c) => c.name === account.personaLabel);
          if (!creator) throw new Error(`brief: no Media Factory creator matches account "${id}"`);
          const allContent = (await ctx.call("mediaFactory", { op: "listContent" })) as Array<{ id: string; creator_id: string; status: string; caption?: string; assets?: { image_path?: string } }>;
          const ready = allContent.filter((c) => c.creator_id === creator.id && c.status === "review" && c.assets?.image_path);
          return ctx.call("social", {
            op: "queuePosts",
            accountId: id,
            items: ready.map((c) => ({ contentItemId: c.id, caption: c.caption ?? "", mediaUrl: c.assets!.image_path! })),
          });
        }
        throw new Error(`brief: unknown source "${source as BriefSource}"`);
      }

      /** Act on many items at once, each isolated so one failure doesn't abort
       * the batch. Returns per-item outcomes. */
      async function actMany(items: BriefItem[], action: BriefAction): Promise<{ acted: Array<{ source: BriefSource; id: string; ok: boolean; error?: string }>; count: number }> {
        const acted: Array<{ source: BriefSource; id: string; ok: boolean; error?: string }> = [];
        for (const item of items) {
          try {
            await actOne(item.source, item.id, action);
            acted.push({ source: item.source, id: item.id, ok: true });
          } catch (e) {
            acted.push({ source: item.source, id: item.id, ok: false, error: (e as Error).message });
          }
        }
        return { acted, count: acted.filter((a) => a.ok).length };
      }

      ctx.provide("brief", async (payload) => {
        const cmd = payload as BriefCommand;

        if (cmd.op === "today") {
          const items = await collectAll();
          return { items, count: items.length };
        }

        if (cmd.op === "act") {
          return actOne(cmd.source, cmd.id, cmd.action);
        }

        if (cmd.op === "autopilot") {
          // Act on every "auto"-tier item, unattended. Reversible/internal by
          // construction (see per-source tiers above). Logged so Mat can see
          // what ATLAS did on its own.
          const items = (await collectAll()).filter((i) => i.tier === "auto");
          const result = await actMany(items, "approve");
          if (result.count > 0) {
            try {
              await ctx.call("memory", {
                op: "remember",
                input: { kind: "timeline", content: `Autopilot: auto-handled ${result.count} reversible item(s) — ${items.map((i) => i.title).join("; ")}`.slice(0, 800) },
              });
            } catch {
              /* memory optional */
            }
          }
          return { ...result, tier: "auto" };
        }

        if (cmd.op === "actBulk") {
          const tier = cmd.tier ?? "bulk";
          const items = (await collectAll()).filter((i) => i.tier === tier && (!cmd.source || i.source === cmd.source));
          return actMany(items, cmd.action);
        }

        throw new Error(`brief: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
