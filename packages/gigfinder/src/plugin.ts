import type { Plugin } from "@atlas/core";
import { GigRegistry } from "./registry";
import { isRealGigCandidate, extractBudget } from "./matching";
import { renderFallbackBid, bidSystemPrompt, isUsableBid } from "./templates";
import { templateWorkPackage, buildHandoffPrompt, isUsableWorkPackage, workPackageSystemPrompt, type WorkPackage } from "./work-package";
import { scoreWinConfidence, matchGigForEmail, WIN_CONFIDENCE_THRESHOLD } from "./win-detection";
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
  /** Turns a gig into a scoped work package + paste-ready Claude Code
   * handoff prompt. Degrades to a deterministic template package when the
   * brain is unavailable or returns something that fails the quality gate. */
  | { op: "planWork"; id: string }
  | { op: "checkWins" }
  | { op: "stats" };

// Phrased to match how real job POSTINGS talk ("looking for", "budget:",
// site-scoped to actual gig boards) rather than casual natural language,
// which just as easily surfaces pricing articles and "how much should I
// charge" discussion threads that happen to share the same keywords.
// Targeted at places real postings actually live. The two generic open-web
// phrase searches these replaced were the source of the 128 junk "gigs"
// found in production on 2026-08-01 — SEO landing pages rank #1 for exactly
// those phrases ("need a developer", "looking for someone"), so the open web
// returns pages *selling* hiring services instead of people hiring.
// r/forhire's own convention tags hiring posts [Hiring], which also filters
// out freelancers advertising themselves.
const WEB_SEARCH_QUERIES = [
  "site:reddit.com/r/forhire [hiring] automation OR python OR scraper",
  "site:reddit.com/r/forhire [hiring] api OR bot OR integration OR script",
  "site:reddit.com/r/jobbit [hiring] automation OR developer",
  "site:reddit.com/r/n8n OR site:reddit.com/r/zapier looking for freelancer OR contractor automation",
];

export function createGigFinderPlugin(opts: { gigFile?: string; registry?: GigRegistry } = {}): Plugin {
  const registry = opts.registry ?? new GigRegistry(opts.gigFile);

  return {
    manifest: {
      name: "gigfinder",
      version: "0.1.0",
      capabilities: ["gigfinder"],
      permissions: ["call:brain", "call:memory", "call:search", "call:email"],
      role: "executor",
    },

    register(ctx) {
      async function searchWeb(): Promise<GigCandidate[]> {
        const out: GigCandidate[] = [];
        for (const query of WEB_SEARCH_QUERIES) {
          try {
            const results = (await ctx.call("search", { op: "web", query, max: 6 })) as Array<{ title: string; url: string; snippet: string }>;
            for (const r of results) {
              if (!isRealGigCandidate(r.title, r.snippet, r.url)) continue;
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
              .filter((i) => isRealGigCandidate(i.title, i.snippet, i.url))
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
          // Validate before storing. A real production bid was once saved as
          // the fragment "Delivery Estimate):* Depending on your clients'" —
          // garbage shown to a prospective client under Mat's name. The
          // deterministic template is always coherent, so it wins over any
          // model output that doesn't look like a real pitch.
          const text = (r.text ?? "").trim();
          return isUsableBid(text) ? text : renderFallbackBid(gig.source, gig.title, gig.budget);
        } catch {
          return renderFallbackBid(gig.source, gig.title, gig.budget);
        }
      }

      /** Scopes a gig into a work package. Extracted so BOTH the planWork op
       * and the win transitions can use it — a won gig gets its package
       * generated automatically, so by the time Mat looks at it the handoff
       * prompt is already sitting there. Same posture as draftBid, which is
       * pre-drafted at search time rather than on demand. */
      async function planWorkFor(gig: Gig): Promise<WorkPackage> {
        // Deterministic package first — it is always coherent, works with
        // zero AI (every provider is quota-exhausted as of 2026-08-01), and
        // is what any brain failure falls back to.
        let pkg: WorkPackage = templateWorkPackage(gig);

        try {
            const r = (await ctx.call("brain", {
              system: workPackageSystemPrompt(),
              prompt: `Job title: ${gig.title}
Posting: ${gig.snippet}
Budget: ${gig.budget ? "$" + gig.budget : "not stated"}
Source: ${gig.url}`,
              needs: { reasoning: 0.7, cost: 1 },
              maxTokens: 900,
              task: "gigfinder.planWork",
            })) as { text: string };

            let raw = (r.text ?? "").trim();
            // Models often fence JSON despite being told not to. Strip the
            // opening fence (plus any language tag) and the closing one; the
            // trim() then removes the newline the fence left behind.
            if (raw.startsWith("```")) raw = raw.replace(/^```[a-z]*/i, "").replace(/```$/, "").trim();
            const parsed = JSON.parse(raw) as Partial<WorkPackage>;
            const candidate = {
              summary: String(parsed.summary ?? "").trim(),
              deliverables: (parsed.deliverables ?? []).map((d) => String(d)),
              questionsForClient: (parsed.questionsForClient ?? []).map((q) => String(q)),
              assumptions: (parsed.assumptions ?? []).map((a) => String(a)),
              techApproach: String(parsed.techApproach ?? "").trim(),
              estimateDays: Number(parsed.estimateDays),
            };
            if (isUsableWorkPackage(candidate)) {
              pkg = { gigId: gig.id, ...candidate, handoffPrompt: buildHandoffPrompt(gig, candidate), generatedBy: "brain" };
            }
        } catch {
          /* brain unavailable, quota-blocked, or unparseable — template stands */
        }

        return pkg;
      }

      ctx.provide("gigfinder", async (payload) => {
        const cmd = payload as GigFinderCommand;

        if (cmd.op === "planWork") {
          const gig = (await registry.list()).find((g) => g.id === cmd.id);
          if (!gig) throw new Error(`no gig "${cmd.id}"`);
          const pkg = await planWorkFor(gig);
          const updated = await registry.update(gig.id, { workPackage: pkg });
          return updated ?? { ...gig, workPackage: pkg };
        }

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
          // Pre-draft a pitch for every new gig right away, so by the time Mat
          // looks at the Brief the draft is already sitting there — approve is
          // just "yes, use this," not a wait-for-the-AI step. Status stays
          // "new": drafting ahead of time is honest (nothing submitted, nothing
          // marked reviewed) whereas auto-approving would misrepresent that Mat
          // signed off on something he hasn't seen yet.
          const drafted: Gig[] = [];
          for (const gig of added) {
            const bid = await draftBid(gig);
            const updated = await registry.update(gig.id, { draftBid: bid });
            if (updated) drafted.push(updated);
          }
          await ctx.emit("gigfinder.searched", { sources, found: added.length });
          return { found: added.length, candidatesScanned: all.length, jobs: drafted.length === added.length ? drafted : added };
        }

        if (cmd.op === "checkWins") {
          const pending = await registry.list("submitted");
          const decided = new Set<string>();
          let checked = 0;
          let won = 0;
          let flagged = 0;
          if (pending.length > 0) {
            const { messages } = (await ctx.call("email", { op: "check", limit: 20 })) as {
              messages: Array<{ from: string; subject: string; date: string; text: string; links: string[] }>;
            };
            for (const msg of messages) {
              checked++;
              try {
                const emailText = `${msg.subject} ${msg.text}`;
                const candidates = pending.filter((g) => !decided.has(g.id));
                const gig = matchGigForEmail(emailText, candidates);
                if (!gig) continue;
                decided.add(gig.id);
                const confidence = scoreWinConfidence(emailText);
                if (confidence >= WIN_CONFIDENCE_THRESHOLD) {
                  // Scope the work immediately on winning, so the handoff
                  // prompt is already waiting by the time Mat looks. Never
                  // let a planning failure undo a detected win.
                  let workPackage;
                  try {
                    workPackage = await planWorkFor(gig);
                  } catch {
                    /* planning is best-effort; the win itself still stands */
                  }
                  await registry.update(gig.id, { status: "won", ...(workPackage ? { workPackage } : {}) });
                  await ctx.emit("gigfinder.won", { id: gig.id });
                  won++;
                } else {
                  await registry.update(gig.id, { status: "responded", notes: emailText.slice(0, 500) });
                  flagged++;
                }
              } catch (err) {
                console.error("[gigfinder] checkWins: failed to classify an email, skipping it:", err instanceof Error ? err.message : String(err));
              }
            }
          }
          return { checked, won, flagged };
        }

        if (cmd.op === "list") return registry.list(cmd.status);

        if (cmd.op === "approve") {
          const gig = await registry.get(cmd.id);
          if (!gig) throw new Error(`no gig "${cmd.id}"`);
          if (gig.status === "responded") {
            // A responded gig already got a client reply flagged as a
            // possible win — approving here means "yes, this is a win," not
            // "start drafting a bid," so it skips straight to "won".
            let workPackage;
            try {
              workPackage = await planWorkFor(gig);
            } catch {
              /* planning is best-effort; confirming the win still stands */
            }
            const updated = await registry.update(cmd.id, { status: "won", ...(workPackage ? { workPackage } : {}) });
            await ctx.emit("gigfinder.won", { id: cmd.id });
            return updated;
          }
          const bid = gig.draftBid ?? (await draftBid(gig)); // pre-drafted at search time; fall back for older gigs
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
