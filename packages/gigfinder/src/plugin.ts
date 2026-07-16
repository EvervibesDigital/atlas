import type { Plugin } from "@atlas/core";
import { GigRegistry } from "./registry";
import { isAiDoable, extractBudget } from "./matching";
import { renderFallbackBid, bidSystemPrompt } from "./templates";
import type { Gig, GigCandidate, GigSource, GigStatus } from "./types";

/**
 * Gig Finder (service "gigfinder") — finds AI-doable freelance work, queues it
 * for review, and drafts a tailored pitch once you approve. It never submits
 * a bid for you: Phase 1 (per the design spec) is search → queue → draft →
 * YOU paste it into the platform and click submit → tell ATLAS via
 * markSubmitted. No account credentials, no auto-click-submit, ever.
 *
 * Sources:
 *   "web"        — Tavily/Serper search API. Sanctioned, ToS-safe. DEFAULT.
 *   "craigslist" — direct scrape. Craigslist's ToS prohibits automated
 *                  collection (litigated: craigslist v. 3Taps/PadMapper) —
 *                  opt-in only, off by default.
 *   "fiverr"/"guru" — scrape via headless browser. Both platforms' ToS forbid
 *                  automated bidding/browsing at scale and run bot detection.
 *                  Opt-in only, off by default, read-only (search/list pages
 *                  only — never touches a login or bid-submission form).
 * Enabling the opt-in sources is a call only Mat makes per search request.
 */
export type GigFinderCommand =
  | { op: "search"; sources?: GigSource[] }
  | { op: "list"; status?: GigStatus }
  | { op: "approve"; id: string }
  | { op: "reject"; id: string }
  | { op: "markSubmitted"; id: string }
  | { op: "updateStatus"; id: string; status: GigStatus; paidAmount?: number }
  | { op: "stats" };

const WEB_SEARCH_QUERIES = [
  "hire freelancer AI automation script $50",
  "need python scraper built freelance gig",
  "looking for someone to automate workflow small project",
];

export function createGigFinderPlugin(opts: { gigFile?: string; registry?: GigRegistry } = {}): Plugin {
  const registry = opts.registry ?? new GigRegistry(opts.gigFile);

  return {
    manifest: {
      name: "gigfinder",
      version: "0.1.0",
      capabilities: ["gigfinder"],
      permissions: ["call:brain", "call:memory", "call:search"],
      role: "executor",
    },

    register(ctx) {
      async function searchWeb(): Promise<GigCandidate[]> {
        const out: GigCandidate[] = [];
        for (const query of WEB_SEARCH_QUERIES) {
          try {
            const results = (await ctx.call("search", { op: "web", query, max: 6 })) as Array<{ title: string; url: string; snippet: string }>;
            for (const r of results) {
              if (!isAiDoable(r.title, r.snippet)) continue;
              out.push({ source: "web", title: r.title, url: r.url, snippet: r.snippet, budget: extractBudget(`${r.title} ${r.snippet}`) });
            }
          } catch {
            /* one query failing shouldn't kill the whole search */
          }
        }
        return out;
      }

      /** Opt-in scrape sources. Lazy-imports @atlas/executor so it's not a hard dependency until used. */
      async function searchScraped(source: Exclude<GigSource, "web">): Promise<GigCandidate[]> {
        const targets: Record<string, { url: string; itemSelector: string; titleSelector?: string; linkSelector?: string; snippetSelector?: string }> = {
          craigslist: { url: "https://newyork.craigslist.org/search/cps", itemSelector: "li.cl-search-result", titleSelector: ".titlestring", linkSelector: "a" },
          fiverr: { url: "https://www.fiverr.com/search/gigs?query=automation", itemSelector: "[data-testid='listing-card']", titleSelector: "h3", linkSelector: "a" },
          guru: { url: "https://www.guru.com/d/jobs/skill/automation/", itemSelector: ".job-item", titleSelector: ".job-title", linkSelector: "a" },
        };
        const t = targets[source];
        if (!t) return [];
        try {
          const { BrowserExecutor } = await import("@atlas/executor");
          const exec = new BrowserExecutor();
          await exec.start();
          try {
            const items = await exec.extractList(t.url, t);
            return items
              .filter((i) => isAiDoable(i.title, i.snippet))
              .map((i) => ({ source, title: i.title, url: i.url, snippet: i.snippet, budget: extractBudget(`${i.title} ${i.snippet}`) }));
          } finally {
            await exec.stop();
          }
        } catch (e) {
          console.error(`[gigfinder] ${source} scrape failed (expected if blocked/changed layout):`, (e as Error).message);
          return [];
        }
      }

      async function draftBid(gig: Gig): Promise<string> {
        try {
          const r = (await ctx.call("brain", {
            system: bidSystemPrompt(gig.source),
            prompt: `Job title: ${gig.title}\nDescription: ${gig.snippet}\nBudget: ${gig.budget ? "$" + gig.budget : "not stated"}`,
            needs: { reasoning: 0.5, cost: 1 },
            maxTokens: 300,
            task: "gigfinder.draftBid",
          })) as { text: string };
          return r.text.trim() || renderFallbackBid(gig.source, gig.title, gig.budget);
        } catch {
          return renderFallbackBid(gig.source, gig.title, gig.budget);
        }
      }

      ctx.provide("gigfinder", async (payload) => {
        const cmd = payload as GigFinderCommand;

        if (cmd.op === "search") {
          const sources = cmd.sources ?? ["web"];
          const all: GigCandidate[] = [];
          for (const s of sources) {
            all.push(...(s === "web" ? await searchWeb() : await searchScraped(s)));
          }
          const added = await registry.addCandidates(all);
          try {
            if (added.length) {
              await ctx.call("memory", { op: "remember", input: { kind: "task", content: `Gig Finder found ${added.length} new AI-doable job(s): ${added.map((g) => g.title).join("; ")}`.slice(0, 1500) } });
            }
          } catch {
            /* memory optional */
          }
          await ctx.emit("gigfinder.searched", { sources, found: added.length });
          return { found: added.length, candidatesScanned: all.length, jobs: added };
        }

        if (cmd.op === "list") return registry.list(cmd.status);

        if (cmd.op === "approve") {
          const gig = await registry.get(cmd.id);
          if (!gig) throw new Error(`no gig "${cmd.id}"`);
          const bid = await draftBid(gig);
          const updated = await registry.update(cmd.id, { status: "approved", draftBid: bid });
          await ctx.emit("gigfinder.approved", { id: cmd.id });
          return updated;
        }

        if (cmd.op === "reject") {
          const updated = await registry.update(cmd.id, { status: "rejected" });
          if (!updated) throw new Error(`no gig "${cmd.id}"`);
          return updated;
        }

        if (cmd.op === "markSubmitted") {
          const updated = await registry.update(cmd.id, { status: "submitted", submittedAt: new Date().toISOString() });
          if (!updated) throw new Error(`no gig "${cmd.id}"`);
          await ctx.emit("gigfinder.submitted", { id: cmd.id });
          return updated;
        }

        if (cmd.op === "updateStatus") {
          const patch: Partial<Gig> = { status: cmd.status };
          if (cmd.paidAmount !== undefined) patch.paidAmount = cmd.paidAmount;
          const updated = await registry.update(cmd.id, patch);
          if (!updated) throw new Error(`no gig "${cmd.id}"`);
          return updated;
        }

        if (cmd.op === "stats") return registry.stats();

        throw new Error(`gigfinder: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
