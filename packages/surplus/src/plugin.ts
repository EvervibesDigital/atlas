import type { Plugin } from "@atlas/core";
import { TwinClient, type FetchLike } from "./twin-client";
import { GoogleSheetsClient } from "./sheets-client";
import type { SurplusLead, SurplusRole } from "./types";

/**
 * Surplus plugin (service "surplus") — brings Mat's "Surplus Funds Platform
 * v2" into ATLAS. That platform is a real, working 6-agent pipeline he built
 * on Twin AI (build.twin.so): County Discovery → Scraper → Enricher →
 * Outreach → Attorney Match/Recruit. It scrapes county foreclosure/tax-sale
 * records for surplus >= $5,000 and its leads already live in Mat's own
 * Google Sheets.
 *
 * Migration posture (phase 1): ATLAS ORCHESTRATES the existing Twin pipeline
 * over its REST API — list agents, trigger runs, see what's scheduled/billing,
 * pull each agent's instructions as the blueprint for a future native rebuild.
 * We deliberately do NOT rebuild the working county scrapers yet
 * ([[feedback_dont_build_workarounds]]); this is the bridge that gets the
 * business "into ATLAS" and de-risks turning Twin off later.
 *
 * Nothing here auto-contacts a property owner or attorney. Outreach stays a
 * gated, human-approved step — same posture as every other ATLAS business.
 *
 * Requires TWIN_API_KEY in the vault (Keys tab). Gracefully reports itself
 * unavailable if unset, same pattern as kdp needing KDP_CRON_SECRET.
 */

/** The six agents that make up the platform, mapped to their Twin agent ids (from the 2026-07-21 pull). */
const AGENT_IDS: Record<SurplusRole, string> = {
  "county-discovery": "019cbf0d-76f6-70e1-b106-9150e93b6e0f",
  scraper: "019cbebb-e091-7dc1-beee-0e9e9a8477ec",
  enricher: "019cbec9-0515-7ef3-9632-7bef4873f711",
  outreach: "019cbedd-7f20-70c2-a3d3-f75a79d7f258",
  "attorney-match": "019cbedd-9dd8-7e81-8ee9-4dee5847a0e6",
  "attorney-recruit": "019cbedd-c62f-7d12-98ec-65be0137a3ad",
};

/** The v2_leads sheet — one of the 5 Google Sheets the Twin platform already writes to (found 2026-07-21). */
const COUNTY_REGISTRY_SHEET_ID = "12-Yzy4OOoVMRq3_CShleyS8EcA0RST1B4GlEOovwFsc";
const LEADS_SHEET_ID = "1bkr0CK7_2dWDvUuP366PSnxHSdZ41DL1BauYARV5OlI";
const MIN_SURPLUS = 5000;

export type SurplusCommand =
  | { op: "listAgents" }
  | { op: "schedules" }
  /** Structural + liveness audit of the County Registry sheet. */
  | { op: "auditCounties"; checkLive?: boolean }
  | { op: "blueprint"; role: SurplusRole }
  | { op: "run"; role: SurplusRole; message?: string }
  | { op: "runEvents"; role: SurplusRole; runId: string }
  | { op: "pause"; role: SurplusRole }
  | { op: "pendingLeads"; limit?: number }
  /** Renders the exact outreach wording for ONE lead so it can be read and
   * approved before anything is sent. Sends nothing. Throws rather than
   * degrading when the lead lacks data the recipient needs to verify the
   * claim — see outreach-templates.ts. */
  | {
      op: "draftOutreach";
      lead: SurplusLead;
      channel?: "letter" | "email";
      feePercent: number;
      senderName: string;
      companyName: string;
      companyAddress: string;
      contactPhone?: string;
      contactEmail?: string;
    };

export function createSurplusPlugin(opts: { fetcher?: FetchLike; twinBase?: string } = {}): Plugin {
  return {
    manifest: {
      name: "surplus",
      version: "0.1.0",
      capabilities: ["surplus"],
      permissions: ["secret:*", "call:memory"],
      role: "executor",
    },

    register(ctx) {
      async function client(): Promise<TwinClient> {
        const key = await ctx.secret("TWIN_API_KEY");
        if (!key) throw new Error("surplus: no TWIN_API_KEY set — add it in the Keys tab to let ATLAS reach your Twin surplus-funds agents");
        return new TwinClient(key, opts.fetcher ?? fetch, opts.twinBase);
      }

      async function sheetsClient(): Promise<GoogleSheetsClient> {
        const clientEmail = await ctx.secret("GOOGLE_SHEETS_CLIENT_EMAIL");
        const privateKey = await ctx.secret("GOOGLE_SHEETS_PRIVATE_KEY");
        if (!clientEmail || !privateKey) {
          throw new Error("surplus: no GOOGLE_SHEETS_CLIENT_EMAIL / GOOGLE_SHEETS_PRIVATE_KEY set — add a Sheets service account in the Keys tab to see individual leads");
        }
        return new GoogleSheetsClient(clientEmail, privateKey, opts.fetcher ?? fetch);
      }

      function agentId(role: SurplusRole): string {
        const id = AGENT_IDS[role];
        if (!id) throw new Error(`surplus: unknown role "${role}"`);
        return id;
      }

      ctx.provide("surplus", async (payload) => {
        const cmd = payload as SurplusCommand;

        if (cmd.op === "draftOutreach") {
          // Renders the letter/email for ONE lead so the exact wording can be
          // read before anything is sent. Sends nothing itself. Throws rather
          // than degrading if the lead is missing data the recipient would
          // need to verify the claim (see outreach-templates.ts).
          const { renderSurplusLetter, renderSurplusEmail } = await import("./outreach-templates");
          const render = cmd.channel === "email" ? renderSurplusEmail : renderSurplusLetter;
          return render({
            ownerName: cmd.lead.owner_name,
            propertyAddress: cmd.lead.property_address,
            caseNumber: cmd.lead.case_number,
            county: cmd.lead.county,
            state: cmd.lead.state,
            estimatedSurplus: cmd.lead.estimated_surplus,
            auctionDate: cmd.lead.auction_date,
            feePercent: cmd.feePercent,
            senderName: cmd.senderName,
            companyName: cmd.companyName,
            companyAddress: cmd.companyAddress,
            contactPhone: cmd.contactPhone,
            contactEmail: cmd.contactEmail,
          });
        }

        if (cmd.op === "pendingLeads") {
          const sheets = await sheetsClient();
          const rows = await sheets.getRows(LEADS_SHEET_ID);
          // Real header row (verified live 2026-07-25): "lead id", "county",
          // "state", "property address", "case number", "auction date",
          // "sale price", "debt owed", "estimated surplus", "lead tier",
          // "lead score", "owner name", "owner email", "owner phone", "owner
          // mailing address", "source url", "date scraped", "email sent",
          // "email sent date", "sms sent", "call attempted", "letter
          // generated", "attorney assigned", "claim status", "estimated
          // commission", "revenue collected" — space-separated, NOT the
          // underscore names used in the platform's own SQLite schema.
          const num = (v: string | undefined) => (v ? Number(v.replace(/[^0-9.-]/g, "")) : undefined);
          const alreadyEmailed = (v: string | undefined) => /^(yes|true|1|y)$/i.test((v ?? "").trim());
          const leads: SurplusLead[] = rows
            .filter((row) => !alreadyEmailed(row["email sent"]))
            .map((row) => ({
              lead_id: row["lead id"] || row["case number"] || undefined,
              county: row["county"] || undefined,
              state: row["state"] || undefined,
              property_address: row["property address"] || undefined,
              case_number: row["case number"] || undefined,
              auction_date: row["auction date"] || undefined,
              sale_price: num(row["sale price"]),
              debt_owed: num(row["debt owed"]),
              estimated_surplus: num(row["estimated surplus"]) ?? 0,
              lead_tier: row["lead tier"] || undefined,
              lead_score: row["lead score"] || undefined,
              owner_name: row["owner name"] || undefined,
              owner_email: row["owner email"] || undefined,
            }))
            .filter((lead) => (lead.estimated_surplus ?? 0) >= MIN_SURPLUS)
            .slice(0, cmd.limit ?? 10);
          return { leads };
        }

        const c = await client();

        if (cmd.op === "listAgents") {
          const agents = await c.listAgents(50);
          return { agents };
        }

        if (cmd.op === "schedules") {
          const schedules = await c.listSchedules();
          return { schedules };
        }

        /**
         * Audit the County Registry sheet that drives the scraper.
         *
         * Run before trusting any scraper built on it: on 2026-08-02 the
         * registry was misaligned by one column AND its URLs were fabricated
         * (2 of the first 3 returned 404). A scraper reading that sheet finds
         * nothing, which is exactly what happened.
         *
         * `checkLive` costs one HTTP request per county, so it is opt-in.
         */
        if (cmd.op === "auditCounties") {
          const { auditRegistry, checkUrls } = await import("./county-registry");
          const sheets = await sheetsClient();
          const rows = (await sheets.getRows(COUNTY_REGISTRY_SHEET_ID)) as Array<Record<string, string>>;
          const audit = auditRegistry(rows);
          if (!cmd.checkLive) return { ...audit, urls: audit.urls.slice(0, 10), checked: false };

          const checks = await checkUrls(audit.urls.map((u) => ({ county: u.county, url: u.url })), opts.fetcher ?? fetch);
          const dead = checks.filter((c) => !c.alive);
          return {
            ...audit,
            urls: undefined,
            checked: true,
            alive: checks.length - dead.length,
            dead: dead.length,
            deadList: dead.slice(0, 25),
          };
        }

        if (cmd.op === "blueprint") {
          const instructions = await c.getInstructions(agentId(cmd.role));
          return { role: cmd.role, instructions };
        }

        if (cmd.op === "run") {
          const res = await c.triggerRun(agentId(cmd.role), cmd.message);
          try {
            await ctx.call("memory", { op: "remember", input: { kind: "task", content: `Surplus: triggered Twin "${cmd.role}" agent (run ${res.run_id ?? "?"})` } });
          } catch {
            /* memory optional */
          }
          await ctx.emit("surplus.run", { role: cmd.role, runId: res.run_id });
          return res;
        }

        if (cmd.op === "runEvents") {
          const events = await c.getRunEvents(agentId(cmd.role), cmd.runId, 150);
          return { events };
        }

        if (cmd.op === "pause") {
          await c.pauseSchedule(agentId(cmd.role));
          return { paused: cmd.role };
        }

        throw new Error(`surplus: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}

export type { SurplusLead };
