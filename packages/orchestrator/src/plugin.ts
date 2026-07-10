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

        // 2. Assess the businesses.
        const brief = (await optional<{ summary: string; recommendations: unknown[] }>(ctx, "business", { op: "brief" })) ?? {
          summary: "No business data yet.",
          recommendations: [],
        };

        // 3. Create today's Reel (required — creative + brain must be present).
        const reel = (await ctx.call("creative", { op: "writeReel", personaHandle, topic })) as ReelLike & { hook: string; caption: string };

        // 4. Sanity-check the plan with the Strategy Council.
        const council = (await optional<{ consensus: string; recommendation: string }>(ctx, "strategy", { op: "convene", decision: `Post a Reel about ${topic}` })) ?? null;

        // 5. Queue it — Publishing gates on Mat's approval; posts nothing.
        const publish = (await ctx.call("publishing", { op: "publish", input: reelToPublishInput(reel, cmd.videoRef ?? null) })) as {
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
        };

        // 7. Gather advice + the approval list for the report.
        const proposals = (await optional<unknown[]>(ctx, "learning", { op: "proposals" })) ?? [];
        const pendingApprovals = (await optional<unknown[]>(ctx, "approvals", { op: "list", status: "pending" })) ?? [];

        const report: DailyReport = {
          date: new Date().toISOString(),
          topic,
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
