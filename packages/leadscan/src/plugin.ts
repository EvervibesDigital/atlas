import type { Plugin } from "@atlas/core";
import { scanWebsite } from "./scanner";
import { findLeads } from "./leadfinder";
import { LeadRegistry } from "./registry";
import type { LeadScanCommand } from "./types";

/**
 * Lead-scan plugin (service "leadscan") — brings the two genuinely useful
 * pieces of Mat's EverVibes Digital compliance-bot repo into ATLAS: the real
 * website "vibe check" scanner and the Gemini/Google-Maps lead finder.
 * Deliberately does NOT stand up the separate React/Firebase app or wire the
 * ~18 redundant Twin agents — both needed either new hosting or fragile
 * agent-log parsing for no benefit over porting ~150 lines of working logic
 * directly. Outreach reuses the ALREADY-BUILT @atlas/outreach bridge (the
 * n8n "New Lead Intake" webhook) instead of a third send pipeline.
 *
 * NOTE: this is unrelated to @atlas/compliance (the content-policy
 * "Compliance Watchdog" that checks captions for FTC-disclosure issues
 * before posting) — same-sounding business concept, completely different
 * package, named "leadscan" specifically to avoid colliding with it.
 *
 * Every lead sits at status "new" until Mat approves it in the Brief —
 * "approve" is the only thing that ever contacts a real business.
 */
export function createLeadScanPlugin(opts: { leadFile?: string; registry?: LeadRegistry; fetcher?: typeof fetch } = {}): Plugin {
  const registry = opts.registry ?? new LeadRegistry(opts.leadFile);
  const f = opts.fetcher ?? fetch;

  return {
    manifest: {
      name: "leadscan",
      version: "0.1.0",
      capabilities: ["leadscan"],
      permissions: ["secret:*", "call:outreach", "call:memory"],
      role: "executor",
    },

    register(ctx) {
      ctx.provide("leadscan", async (payload) => {
        const cmd = payload as LeadScanCommand;

        if (cmd.op === "scan") {
          return scanWebsite(cmd.url, f);
        }

        if (cmd.op === "findLeads") {
          const apiKey = await ctx.secret("GEMINI_API_KEY");
          if (!apiKey) throw new Error("leadscan: no GEMINI_API_KEY set — add it in the Keys tab");
          const found = await findLeads(cmd.niche, cmd.city, apiKey, f);
          const added = await registry.addFound(cmd.niche, cmd.city, found);
          // Scan each new lead's site right away — same "pre-draft ahead of
          // time" posture as gigfinder: by the time Mat looks at the Brief,
          // the score + issues are already there, not generated on approve.
          for (const lead of added) {
            try {
              const scan = await scanWebsite(lead.website, f);
              await registry.attachScan(lead.id, scan);
            } catch {
              /* one bad site shouldn't block the rest of the batch */
            }
          }
          try {
            if (added.length) {
              await ctx.call("memory", { op: "remember", input: { kind: "task", content: `Lead scan: found ${added.length} new lead(s) in ${cmd.niche}/${cmd.city}: ${added.map((l) => l.businessName).join("; ")}`.slice(0, 1500) } });
            }
          } catch {
            /* memory optional */
          }
          return { found: added.length, leads: await registry.list("new") };
        }

        if (cmd.op === "list") {
          return registry.list(cmd.status);
        }

        if (cmd.op === "approve") {
          const lead = await registry.get(cmd.id);
          if (!lead) throw new Error(`leadscan: no lead "${cmd.id}"`);
          // Refuse to claim an outreach that cannot happen. This previously
          // sent `email: ""` to the n8n workflow and marked the lead
          // "contacted" regardless — which is how all 128 production leads
          // ended up flagged as contacted with zero email addresses between
          // them. A status that lies is worse than an error.
          if (!(lead.email ?? "").includes("@")) {
            throw new Error(
              `leadscan: no email address for "${lead.businessName}" — nothing to send to, so it has NOT been marked contacted. The site scan finds an address when the page publishes one; this site did not. Phone on file: ${lead.phone || "none"}.`,
            );
          }
          const result = await ctx.call("outreach", {
            op: "notify",
            target: "new-lead",
            payload: { name: lead.businessName, email: lead.email ?? "", phone: lead.phone ?? "", service: "Website Compliance Audit", source: "ATLAS Compliance Scanner" },
          });
          const updated = await registry.update(cmd.id, { status: "contacted" });
          return { ...updated, outreach: result };
        }

        if (cmd.op === "reject") {
          const updated = await registry.update(cmd.id, { status: "rejected" });
          if (!updated) throw new Error(`leadscan: no lead "${cmd.id}"`);
          return updated;
        }

        throw new Error(`leadscan: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
