import type { Plugin } from "@atlas/core";
import { scanWebsite } from "./scanner";
import { renderComplianceOutreach } from "./outreach-copy";
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
 * directly.
 *
 * ⚠️ OUTREACH CAVEAT (established 2026-08-01 by inspecting the live n8n
 * workflow): `approve` posts to the n8n "new-lead" webhook, which is served by
 * `ARCHIVED-W3 - New Lead Intake` — an INBOUND intake flow ending in "Send
 * Lead Confirmation", i.e. a thanks-for-contacting-us reply. That is the wrong
 * message for a business who has never heard of Mat. Use `draftOutreach` for
 * real cold outreach: it renders copy citing the actual audit findings, to be
 * read and approved before sending.
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
      permissions: ["secret:*", "call:outreach", "call:memory", "call:sender"],
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

        if (cmd.op === "draftOutreach") {
          // Renders the exact cold-email wording for ONE lead so it can be
          // read before anything is sent. Sends nothing. Refuses rather than
          // degrades when the lead has no email or no scan findings — the
          // entire pitch rests on naming real, checkable problems.
          const lead = await registry.get(cmd.id);
          if (!lead) throw new Error(`leadscan: no lead "${cmd.id}"`);
          return renderComplianceOutreach({
            lead,
            senderName: cmd.senderName,
            companyName: cmd.companyName,
            companyAddress: cmd.companyAddress,
            startingPrice: cmd.startingPrice,
          });
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

        /**
         * Render cold-outreach emails for a batch of leads, ready to hand
         * straight to `sender`.
         *
         * Identity comes from secrets rather than the request so the postal
         * address in the body is the same one configured everywhere else —
         * a per-call address is a per-call opportunity to send a
         * non-compliant email.
         *
         * Leads that cannot be written to are REPORTED, not silently dropped:
         * "3 of 7 drafted" plus the reason is actionable, whereas 3 emails
         * appearing from a list of 7 just looks broken.
         */
        /** Shared by `draftBatch` and `autoOutreach` so the two paths render
         * IDENTICAL copy — the only difference between them is who presses
         * send, never what the email says. */
        async function draftEligible(ids?: string[], startingPriceOverride?: string) {
          const senderName = (await ctx.secret("SENDER_NAME")) ?? "Mat";
          const companyName = (await ctx.secret("COMPANY_NAME")) ?? "EverVibes";
          const companyAddress = await ctx.secret("COMPANY_POSTAL_ADDRESS");
          if (!companyAddress) {
            throw new Error("leadscan: COMPANY_POSTAL_ADDRESS is not set — commercial email legally requires a physical address in the body.");
          }
          const startingPrice = startingPriceOverride ?? (await ctx.secret("COMPLIANCE_STARTING_PRICE")) ?? undefined;

          const all = await registry.list("new");
          const chosen = ids?.length ? all.filter((l) => ids.includes(l.id)) : all;

          const emails: Array<{ leadId: string; to: string; subject: string; body: string }> = [];
          const skipped: Array<{ leadId: string; businessName: string; reason: string }> = [];
          for (const lead of chosen) {
            try {
              // renderComplianceOutreach refuses on a lead with no findings —
              // a perfect site has nothing to sell, and pitching it anyway is
              // the generic agency spam this whole approach exists to beat.
              const rendered = renderComplianceOutreach({ lead, senderName, companyName, companyAddress, startingPrice });
              emails.push({ leadId: lead.id, ...rendered });
            } catch (err) {
              skipped.push({ leadId: lead.id, businessName: lead.businessName, reason: (err as Error).message });
            }
          }
          return { emails, skipped, considered: chosen.length };
        }

        if (cmd.op === "draftBatch") {
          const { emails, skipped, considered } = await draftEligible(cmd.ids, cmd.startingPrice);
          return { emails, skipped, drafted: emails.length, considered };
        }

        /**
         * Unattended: draft the eligible leads and send whatever clears every
         * check, no human read step. This is the daily-digest path — Mat
         * reviews what WENT OUT after the fact, not before.
         *
         * Routed through `sender.sendAutonomous`, never `send`: `send` is
         * all-or-nothing over a human-approved batch, which is right when a
         * person is choosing what to approve. With nobody choosing, one bad
         * lead in the batch would silently block every good one behind it.
         */
        if (cmd.op === "autoOutreach") {
          const { emails, skipped: draftSkipped } = await draftEligible(cmd.ids, cmd.startingPrice);
          if (!emails.length) return { drafted: 0, sent: 0, sendSkipped: 0, draftSkipped: draftSkipped.length };

          const result = (await ctx.call("sender", {
            op: "sendAutonomous",
            emails: emails.map((e) => ({ to: e.to, subject: e.subject, body: e.body })),
            confirmSend: true,
            source: "leadscan",
            maxPerRun: cmd.maxPerRun,
          })) as { sentCount: number; skippedCount: number; sent: Array<{ to: string }> };

          // Only marked contacted for addresses that ACTUALLY went out — this
          // is exactly how 128 leads once ended up flagged contacted with
          // nothing sent, and the fix is the same here as it was there.
          const byEmail = new Map(emails.map((e) => [e.to, e.leadId]));
          const deliveredIds = result.sent.map((s) => byEmail.get(s.to)).filter((id): id is string => Boolean(id));
          for (const id of deliveredIds) await registry.update(id, { status: "contacted" });

          if (deliveredIds.length) {
            try {
              await ctx.call("memory", {
                op: "remember",
                input: { kind: "task", content: `Auto-sent compliance outreach to ${deliveredIds.length} lead(s) overnight.` },
              });
            } catch {
              /* memory optional */
            }
          }

          return { drafted: emails.length, sent: result.sentCount, sendSkipped: result.skippedCount, draftSkipped: draftSkipped.length, markedContacted: deliveredIds.length };
        }

        /**
         * Mark a lead contacted after `sender` genuinely delivered to it.
         *
         * Deliberately NOT `approve`: that op fires the n8n "new-lead"
         * workflow, which ends in a thanks-for-contacting-us confirmation.
         * Sending that to a business who has never heard of Mat, on top of the
         * cold email just delivered, is two wrong emails instead of one right
         * one.
         */
        if (cmd.op === "markSent") {
          const updated = await registry.update(cmd.id, { status: "contacted" });
          if (!updated) throw new Error(`leadscan: no lead "${cmd.id}"`);
          try {
            await ctx.call("memory", {
              op: "remember",
              input: { kind: "task", content: `Compliance outreach sent to ${updated.businessName} (${updated.email})`.slice(0, 500) },
            });
          } catch {
            /* memory optional */
          }
          return updated;
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
