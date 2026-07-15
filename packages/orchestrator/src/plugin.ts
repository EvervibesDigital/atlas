import type { AtlasContext, Plugin } from "@atlas/core";
import type { DailyReport, OrchestratorCommand, ReelLike } from "./core";
import { deriveTopic, reelToPublishInput } from "./core";

/** Call a service, returning undefined instead of throwing if it's absent. */
async function optional<T>(ctx: AtlasContext, service: string, payload: unknown): Promise<T | undefined> {
  try {
    return (await ctx.call(service, payload)) as T;
  } catch {
    return undefined;
  }
}

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
      ],
      role: "planner",
    },

    register(ctx) {
      ctx.provide("orchestrator", async (payload) => {
        const cmd = payload as OrchestratorCommand;
        if (cmd.op !== "runDailyCycle") throw new Error(`orchestrator: unknown op "${(cmd as { op: string }).op}"`);

        const personaHandle = cmd.personaHandle ?? defaultPersona;

        // 1. Which persona, and what should it talk about today?
        const persona = await optional<{ contentPillars?: string[] }>(ctx, "personas", { op: "get", handle: personaHandle });
        const daySeed = Math.floor(Date.now() / 86_400_000);
        const topic = cmd.topic ?? deriveTopic(persona?.contentPillars ?? [], daySeed);

        // 1b. RECALL — close the learning loop. Before deciding anything, pull
        // the most relevant lessons ATLAS has stored (past successes/failures,
        // newsletter findings, learnings) for today's topic. Without this the
        // cycle only ever WRITES to memory and never learns from it.
        const recalled = (await optional<Array<{ record: { content: string; kind: string } }>>(ctx, "memory", {
          op: "search",
          query: `${topic} lessons, what worked, what failed, opportunities`,
          options: { limit: 5, minScore: 0.12 },
        })) ?? [];
        const lessons = recalled.map((r) => r.record.content);

        // 2. Assess the businesses.
        const brief = (await optional<{ summary: string; recommendations: unknown[] }>(ctx, "business", { op: "brief" })) ?? {
          summary: "No business data yet.",
          recommendations: [],
        };

        // 3. Create today's Reel (required — creative + brain must be present).
        // 3. Create today's Reel (required — creative + brain must be present).
        const reel = (await ctx.call("creative", { op: "writeReel", personaHandle, topic })) as ReelLike & { hook: string; caption: string; voice: string; scenes: Array<{ text: string; imageUrl: string }> };

        // 3b. Render the vertical video to produce a real MP4!
        let videoRef = cmd.videoRef ?? null;
        if (!videoRef) {
          try {
            console.log(`[orchestrator] Rendering video for topic: ${topic}`);
            const renderResult = await ctx.call("publishing", { op: "render", spec: reel }) as { videoPath: string };
            videoRef = renderResult.videoPath;
          } catch (err) {
            console.error("[orchestrator] Video rendering failed, proceeding without videoRef:", err);
          }
        }

        // 4. Sanity-check the plan with the Strategy Council.
        const council = (await optional<{ consensus: string; recommendation: string }>(ctx, "strategy", { op: "convene", decision: `Post a Reel about ${topic}` })) ?? null;

        // 5. Queue it — Publishing gates on Mat's approval.
        const publish = (await ctx.call("publishing", { op: "publish", input: reelToPublishInput(reel, videoRef) })) as {
          status: string;
          detail: string;
          approvalId?: string;
        };

        // 6. Compliance-check the caption + pull headline KPIs.
        const compliance = (await optional<unknown[]>(ctx, "compliance", { op: "check", text: reel.caption })) ?? [];
        const kpis = (await optional<unknown>(ctx, "analytics", { op: "kpis" })) ?? null;

        // 6b. Study one of Mat's businesses (rotates each cycle — how ATLAS
        // learns his businesses overnight). Read-only; safe to run autonomously.
        const learned = (await optional<unknown>(ctx, "business", { op: "research-next" })) ?? null;

        // 6c. Check the GitHub inbox for instructions Mat sent from the road
        // (only if configured via env — works in the cloud cycle too).
        const inboxRepo = process.env.ATLAS_INBOX_REPO;
        const inboxToken = process.env.GITHUB_TOKEN;
        const inbox = inboxRepo && inboxToken ? ((await optional<unknown>(ctx, "inbox", { op: "check", repo: inboxRepo, token: inboxToken })) ?? null) : null;

        // 6d. Daily intelligence sweep — everything optional/graceful (a missing
        // service or key just skips that item). This is how ATLAS gets smarter
        // and hunts improvements/free tools every night, hands-free.
        const intel = {
          curiosity: (await optional<unknown>(ctx, "curiosity", { op: "ideas" })) ?? null,
          repoScout: (await optional<unknown>(ctx, "search", { op: "scout", query: "autonomous AI agent framework OR MCP server OR open-source LLM tools", max: 6 })) ?? null,
          freeTools: (await optional<unknown>(ctx, "search", { op: "freeApis", topic: "content automation, AI agents, and social posting" })) ?? null,
          github: (await optional<unknown>(ctx, "connectors", { op: "sync", which: "github" })) ?? null,
          tidy: (await optional<unknown>(ctx, "janitor", { op: "tidy" })) ?? null,
          // Daily knowledge ingestion: read the tech newsletters and summarize
          // each into shared memory (via the web service's learn op). This is
          // what future cycles RECALL at step 1b — the ingestion→recall loop.
          newsletters: (await optional<unknown>(ctx, "newsletter", { op: "readDaily" })) ?? null,
        };

        // 7. Gather advice + the approval list for the report.
        const proposals = (await optional<unknown[]>(ctx, "learning", { op: "proposals" })) ?? [];
        const pendingApprovals = (await optional<unknown[]>(ctx, "approvals", { op: "list", status: "pending" })) ?? [];

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
        };

        await optional(ctx, "memory", {
          op: "remember",
          input: { kind: "timeline", content: `Daily cycle: drafted a Reel about "${topic}"; ${pendingApprovals.length} item(s) awaiting approval`, metadata: { topic } },
        });
        await ctx.emit("orchestrator.cycle", { topic, pending: pendingApprovals.length, publish: publish.status });

        return report;
      });
    },
  };
}
