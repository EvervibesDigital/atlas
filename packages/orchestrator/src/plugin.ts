import type { AtlasContext, Plugin } from "@atlas/core";
import type { DailyReport, OrchestratorCommand, ReelLike, CycleHealthTracker } from "./core";
import { deriveTopic, reelToPublishInput, optional } from "./core";

/**
 * Orchestrator plugin (service "orchestrator") — the autonomous agent loop.
 *
 * `runDailyCycle` is one full day's work: assess the businesses (Business
 * brief), pick a topic, write a Reel (Creative), sanity-check it (Strategy
 * Council), queue it for approval (Publishing — which gates on Mat), gather
 * improvement proposals (Learning) and the pending approval list, then file a
 * timeline note. It returns a DailyReport — Mat's morning briefing.
 *
 * Role `planner`: it conducts and delegates; it never executes risky actions
 * itself (posting still goes through the Approval Gateway).
 *
 * Every non-critical step goes through `optional()` (from `./core`), which
 * bounds it with a generous timeout and records success/failure into a
 * shared `CycleHealthTracker` — this is what makes `cycleHealth` in the
 * returned report meaningful, and what stops one hung/failing service from
 * silently blocking or being invisible in every future cycle run.
 */
export function createOrchestratorPlugin(opts: { defaultPersona?: string } = {}): Plugin {
  const defaultPersona = opts.defaultPersona ?? "@everspark.ai";

  return {
    manifest: {
      name: "orchestrator",
      version: "0.1.0",
      capabilities: ["orchestrator"],
      permissions: [
        "call:personas",
        "call:business",
        "call:creative",
        "call:strategy",
        "call:publishing",
        "call:learning",
        "call:approvals",
        "call:memory",
        "call:compliance",
        "call:analytics",
        "call:inbox",
        "call:curiosity",
        "call:search",
        "call:connectors",
        "call:janitor",
        "call:newsletter",
        "call:gigfinder",
        "call:kdp",
        "call:mediaFactory",
      ],
      role: "planner",
    },

    register(ctx) {
      ctx.provide("orchestrator", async (payload) => {
        const cmd = payload as OrchestratorCommand;
        if (cmd.op !== "runDailyCycle") throw new Error(`orchestrator: unknown op "${(cmd as { op: string }).op}"`);

        const personaHandle = cmd.personaHandle ?? defaultPersona;
        const health: CycleHealthTracker = { succeeded: 0, failures: [] };

        // 1. Which persona, and what should it talk about today?
        const persona = await optional<{ contentPillars?: string[] }>(ctx.call, "personas", { op: "get", handle: personaHandle }, health);
        const daySeed = Math.floor(Date.now() / 86_400_000);
        const topic = cmd.topic ?? deriveTopic(persona?.contentPillars ?? [], daySeed);

        // 1b. RECALL — close the learning loop. Before deciding anything, pull
        // the most relevant lessons ATLAS has stored (past successes/failures,
        // newsletter findings, learnings) for today's topic. Without this the
        // cycle only ever WRITES to memory and never learns from it.
        const recalled = (await optional<Array<{ record: { content: string; kind: string } }>>(ctx.call, "memory", {
          op: "search",
          query: `${topic} lessons, what worked, what failed, opportunities`,
          options: { limit: 5, minScore: 0.12 },
        }, health)) ?? [];
        const lessons = recalled.map((r) => r.record.content);

        // 2. Assess the businesses.
        const brief = (await optional<{ summary: string; recommendations: unknown[] }>(ctx.call, "business", { op: "brief" }, health)) ?? {
          summary: "No business data yet.",
          recommendations: [],
        };

        // 3. Create today's Reel (required — creative + brain must be present).
        const reel = (await ctx.call("creative", { op: "writeReel", personaHandle, topic })) as ReelLike & { hook: string; caption: string; voice: string; scenes: Array<{ text: string; imageUrl: string }> };

        // 3b. Try to render a real MP4. Time-boxed: the renderer can involve
        // network image/voice generation with no timeouts of its own, and a
        // hang here must never stall the whole daily cycle. On failure or
        // timeout, publishing falls back to "pending-render" (still queues
        // everything else) rather than blocking.
        let videoRef = cmd.videoRef ?? null;
        if (!videoRef) {
          try {
            console.log(`[orchestrator] Rendering video for topic: ${topic}`);
            const renderResult = (await Promise.race([
              ctx.call("publishing", { op: "render", spec: reel }),
              new Promise((_, reject) => setTimeout(() => reject(new Error("render timed out after 30s")), 30_000)),
            ])) as { videoPath: string };
            videoRef = renderResult.videoPath || null;
          } catch (err) {
            console.error("[orchestrator] Video rendering failed or timed out, proceeding without videoRef:", err);
          }
        }

        // 4. Sanity-check the plan with the Strategy Council.
        const council = (await optional<{ consensus: string; recommendation: string }>(ctx.call, "strategy", { op: "convene", decision: `Post a Reel about ${topic}` }, health)) ?? null;

        // 5. Queue it — Publishing gates on Mat's approval.
        const publish = (await ctx.call("publishing", { op: "publish", input: reelToPublishInput(reel, videoRef) })) as {
          status: string;
          detail: string;
          approvalId?: string;
        };

        // 6. Compliance-check the caption + pull headline KPIs.
        const compliance = (await optional<unknown[]>(ctx.call, "compliance", { op: "check", text: reel.caption }, health)) ?? [];
        const kpis = (await optional<unknown>(ctx.call, "analytics", { op: "kpis" }, health)) ?? null;

        // 6b. Study one of Mat's businesses (rotates each cycle — how ATLAS
        // learns his businesses overnight). Read-only; safe to run autonomously.
        const learned = (await optional<unknown>(ctx.call, "business", { op: "research-next" }, health)) ?? null;

        // 6c. Check the GitHub inbox for instructions Mat sent from the road
        // (only if configured via env — works in the cloud cycle too).
        const inboxRepo = process.env.ATLAS_INBOX_REPO;
        const inboxToken = process.env.GITHUB_TOKEN;
        const inbox = inboxRepo && inboxToken ? ((await optional<unknown>(ctx.call, "inbox", { op: "check", repo: inboxRepo, token: inboxToken }, health)) ?? null) : null;

        // 6d. Daily intelligence sweep, run in PARALLEL (was sequential) —
        // each of these ten calls is independent of the others, so one
        // hung/slow service (e.g. KDP generate on a bad night) no longer
        // delays or blocks curiosity/gig-finder/media-factory/etc., and can
        // no longer stall the whole cycle (each is timeout-bounded inside
        // `optional()`).
        const [curiosity, repoScout, freeTools, github, tidy, newsletters, gigs, kdpScan, kdpGenerate, mediaFactory] = await Promise.all([
          optional<unknown>(ctx.call, "curiosity", { op: "ideas" }, health),
          optional<unknown>(ctx.call, "search", { op: "scout", query: "autonomous AI agent framework OR MCP server OR open-source LLM tools", max: 6 }, health),
          optional<unknown>(ctx.call, "search", { op: "freeApis", topic: "content automation, AI agents, and social posting" }, health),
          optional<unknown>(ctx.call, "connectors", { op: "sync", which: "github" }, health),
          optional<unknown>(ctx.call, "janitor", { op: "tidy" }, health),
          // Daily knowledge ingestion: read the tech newsletters and summarize
          // each into shared memory (via the web service's learn op). This is
          // what future cycles RECALL at step 1b — the ingestion→recall loop.
          optional<unknown>(ctx.call, "newsletter", { op: "readDaily" }, health),
          // Gig Finder — sanctioned-search-only (web/Tavily) every cycle so
          // opportunities queue up for review without Mat manually clicking
          // search each time. The riskier scrape sources (craigslist/fiverr/
          // guru) stay manual-trigger-only from the UI, never automatic.
          optional<unknown>(ctx.call, "gigfinder", { op: "search", sources: ["web"] }, health),
          // KDP — "constantly creating": scan for new book opportunities, then
          // build metadata+PDF for the top few unbuilt ones every cycle. Real
          // pipeline lives in evervibes; this just keeps it fed. Skipped
          // gracefully if KDP_CRON_SECRET isn't configured yet.
          optional<unknown>(ctx.call, "kdp", { op: "scan" }, health),
          optional<unknown>(ctx.call, "kdp", { op: "generate", limit: 3 }, health),
          // Media Factory — "constantly creating": one autoCycle step per
          // orchestrator run (plan a fresh calendar for a creator with an
          // empty queue, or produce the next planned post's script). Never
          // posts; everything lands in "review" for Mat to approve. No-ops
          // gracefully if DATABASE_URL isn't configured yet.
          optional<unknown>(ctx.call, "mediaFactory", { op: "autoCycle" }, health),
        ]);
        const intel = {
          curiosity: curiosity ?? null,
          repoScout: repoScout ?? null,
          freeTools: freeTools ?? null,
          github: github ?? null,
          tidy: tidy ?? null,
          newsletters: newsletters ?? null,
          gigs: gigs ?? null,
          kdpScan: kdpScan ?? null,
          kdpGenerate: kdpGenerate ?? null,
          mediaFactory: mediaFactory ?? null,
        };

        // 7. Gather advice + the approval list for the report.
        const proposals = (await optional<unknown[]>(ctx.call, "learning", { op: "proposals" }, health)) ?? [];
        const pendingApprovals = (await optional<unknown[]>(ctx.call, "approvals", { op: "list", status: "pending" }, health)) ?? [];

        const report: DailyReport = {
          date: new Date().toISOString(),
          topic,
          lessons,
          brief,
          topPriorities: brief.recommendations.slice(0, 3),
          reel: { hook: reel.hook, caption: reel.caption },
          council,
          publish,
          compliance,
          kpis,
          learned,
          inbox,
          intel,
          proposals,
          pendingApprovals,
          cycleHealth: { succeeded: health.succeeded, failed: health.failures.length, failures: health.failures },
        };

        // This one memory write is fire-and-forget informational (a timeline
        // note), not tracked in health — losing it isn't a "cycle step
        // failed" in the sense Mat cares about, and it happens after
        // cycleHealth is already computed above.
        try {
          await ctx.call("memory", {
            op: "remember",
            input: { kind: "timeline", content: `Daily cycle: drafted a Reel about "${topic}"; ${pendingApprovals.length} item(s) awaiting approval`, metadata: { topic } },
          });
        } catch {
          /* best-effort timeline note; not a cycle-health-tracked step */
        }
        await ctx.emit("orchestrator.cycle", { topic, pending: pendingApprovals.length, publish: publish.status });

        return report;
      });
    },
  };
}
