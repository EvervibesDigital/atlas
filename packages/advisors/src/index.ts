import type { AtlasContext, Plugin } from "@atlas/core";

/**
 * Advisor agents — a set of thin, Brain-driven agents that add intelligence to
 * ATLAS. Deduped/combined from Matt's wishlist:
 *   • Curiosity  = Curiosity Engine + World Scanner + Revenue/Integration Hunter
 *   • Red Team   = Red Team (stress-tests ideas)
 *   • Legacy     = Legacy Agent (learns Matt's decision style, "what would Matt do?")
 *   • Archaeologist = Memory Archaeologist (resurfaces old, newly-relevant ideas)
 *   • Janitor    = Digital Janitor (keeps ATLAS's memory tidy)
 * (World-scanning uses the read-only `web` plugin; Self-Evolution and Knowledge
 * Synthesis are already covered by Learning + Skills/Forge + @atlas/knowledge.)
 */

async function ask(ctx: AtlasContext, system: string, prompt: string, maxTokens = 1400): Promise<string> {
  const r = (await ctx.call("brain", { system, prompt, needs: { reasoning: 0.8, creativity: 0.6, cost: 1 }, maxTokens, task: "advisor" })) as { text: string };
  return r.text;
}

async function recall(ctx: AtlasContext, query: string, limit = 8): Promise<string> {
  try {
    const hits = (await ctx.call("memory", { op: "search", query, options: { limit } })) as Array<{ record: { content: string } }>;
    return hits.map((h) => `- ${h.record.content}`).join("\n");
  } catch {
    return "";
  }
}

async function remember(ctx: AtlasContext, kind: string, content: string): Promise<void> {
  try {
    await ctx.call("memory", { op: "remember", input: { kind, content: content.slice(0, 2500) } });
  } catch {
    /* memory optional */
  }
}

/** 🧠 Curiosity Engine — proactive daily ideas across Matt's businesses. */
export function createCuriosityPlugin(): Plugin {
  return {
    manifest: { name: "curiosity", version: "0.1.0", capabilities: ["curiosity"], permissions: ["call:brain", "call:memory", "call:business"], role: "executor" },
    register(ctx) {
      ctx.provide("curiosity", async (payload) => {
        const cmd = payload as { op: "ideas"; focus?: string };
        if (cmd.op !== "ideas") throw new Error("curiosity: unknown op");
        let businesses = "";
        try {
          const list = (await ctx.call("business", { op: "listBusinesses" })) as Array<{ name: string; goal: string }>;
          businesses = list.map((b) => `${b.name}: ${b.goal}`).join("; ");
        } catch {
          /* optional */
        }
        const context = await recall(ctx, cmd.focus ?? "business opportunities and tools", 6);
        const text = await ask(
          ctx,
          "You are ATLAS's Curiosity Engine — proactive, entrepreneurial, specific. Using Matt's businesses and notes, generate TODAY's ideas. Output sections: 5 automation ideas, 5 SaaS/product ideas, 5 revenue/opportunity plays, 3 competitor weaknesses, 3 free tools or APIs worth adopting, and ONE high-confidence pick to pursue with why. Be concrete to his ventures; no fluff.",
          `Matt's businesses: ${businesses || "(unknown)"}\n\nRelevant notes:\n${context}\n\nFocus: ${cmd.focus ?? "anything high-leverage"}`,
          1800,
        );
        await remember(ctx, "project", `Curiosity ideas (${new Date().toISOString().slice(0, 10)}): ${text}`);
        await ctx.emit("curiosity.ideas", { at: new Date().toISOString() });
        return { ideas: text };
      });
    },
  };
}

/** 🔴 Red Team — ruthlessly stress-tests an idea before Matt commits. */
export function createRedTeamPlugin(): Plugin {
  return {
    manifest: { name: "redteam", version: "0.1.0", capabilities: ["redteam"], permissions: ["call:brain", "call:memory"], role: "executor" },
    register(ctx) {
      ctx.provide("redteam", async (payload) => {
        const cmd = payload as { op: "challenge"; idea: string };
        if (cmd.op !== "challenge") throw new Error("redteam: unknown op");
        const text = await ask(
          ctx,
          "You are ATLAS's Red Team. Ruthlessly stress-test the idea. Answer, in order: 1) What could go wrong? 2) Would customers actually pay, and how much? 3) Legal/compliance risks? 4) How easily can competitors copy it? 5) The single biggest risk. End with GO / NO-GO / GO-IF, and the ONE thing to de-risk first. Be blunt and specific.",
          cmd.idea,
        );
        await remember(ctx, "project", `Red Team on "${cmd.idea.slice(0, 80)}": ${text}`);
        return { critique: text };
      });
    },
  };
}

/** 🧬 Legacy Agent — learns Matt's decision style; answers "what would Matt do?" */
export function createLegacyPlugin(): Plugin {
  return {
    manifest: { name: "legacy", version: "0.1.0", capabilities: ["legacy"], permissions: ["call:brain", "call:memory"], role: "executor" },
    register(ctx) {
      ctx.provide("legacy", async (payload) => {
        const cmd = payload as { op: "learn"; decision: string; rationale?: string } | { op: "advise"; question: string; options?: string[] };
        if (cmd.op === "learn") {
          await remember(ctx, "preference", `Matt decided: ${cmd.decision}${cmd.rationale ? ` — because ${cmd.rationale}` : ""}`);
          return { learned: true };
        }
        if (cmd.op === "advise") {
          const past = await recall(ctx, cmd.question, 10);
          const text = await ask(
            ctx,
            "You are Matt's Legacy Agent. You have learned his decision-making style, priorities, business philosophy, and product standards from his past decisions below. Advise what Matt would most likely choose and WHY, in his voice — decisive, practical, lean, long-term. If you lack signal, say what you'd need to know.",
            `Matt's past decisions:\n${past || "(not much yet)"}\n\nQuestion: ${cmd.question}${cmd.options ? `\nOptions: ${cmd.options.join(" | ")}` : ""}`,
          );
          return { advice: text };
        }
        throw new Error("legacy: unknown op");
      });
    },
  };
}

/** 🏺 Memory Archaeologist — resurfaces old ideas that matter again now. */
export function createArchaeologistPlugin(): Plugin {
  return {
    manifest: { name: "archaeologist", version: "0.1.0", capabilities: ["archaeologist"], permissions: ["call:brain", "call:memory"], role: "executor" },
    register(ctx) {
      ctx.provide("archaeologist", async (payload) => {
        const cmd = payload as { op: "dig"; topic?: string };
        if (cmd.op !== "dig") throw new Error("archaeologist: unknown op");
        const notes = await recall(ctx, cmd.topic ?? "ideas opportunities plans", 15);
        const text = await ask(
          ctx,
          "You are ATLAS's Memory Archaeologist. Review these past notes/ideas and surface the 1-3 that are most worth REVISITING now given current priorities. For each: quote the gist, then say why it's newly relevant and the next step. Ignore anything already done.",
          notes || "(no notes yet)",
        );
        return { findings: text };
      });
    },
  };
}

/** Count near-duplicate memory records (same normalized content). */
export function findDuplicates(records: Array<{ content: string }>): number {
  const seen = new Set<string>();
  let dupes = 0;
  for (const r of records) {
    const k = r.content.trim().toLowerCase().slice(0, 200);
    if (seen.has(k)) dupes++;
    else seen.add(k);
  }
  return dupes;
}

export function summarizeMemory(records: Array<{ kind: string; content: string }>): { total: number; byKind: Record<string, number>; duplicates: number } {
  const byKind: Record<string, number> = {};
  for (const r of records) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
  return { total: records.length, byKind, duplicates: findDuplicates(records) };
}

/** 🧹 Digital Janitor — keeps ATLAS's memory tidy (reports; deletions need approval). */
export function createJanitorPlugin(): Plugin {
  return {
    manifest: { name: "janitor", version: "0.1.0", capabilities: ["janitor"], permissions: ["call:memory"], role: "executor" },
    register(ctx) {
      ctx.provide("janitor", async (payload) => {
        const cmd = payload as { op: "tidy" };
        if (cmd.op !== "tidy") throw new Error("janitor: unknown op");
        let records: Array<{ kind: string; content: string }> = [];
        try {
          records = (await ctx.call("memory", { op: "recent", limit: 500 })) as Array<{ kind: string; content: string }>;
        } catch {
          /* optional */
        }
        const summary = summarizeMemory(records);
        await ctx.emit("janitor.tidy", summary);
        return summary;
      });
    },
  };
}
