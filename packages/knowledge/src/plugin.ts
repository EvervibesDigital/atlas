import type { Plugin } from "@atlas/core";
import { synthesize } from "./synth";

interface MemoryHit {
  record: { content: string };
}

interface ReflectionEvent {
  category?: string;
  lesson?: string;
}

/** How many new reflections in one category accumulate before knowledge auto-refreshes that category's playbook. */
const AUTO_SYNTH_THRESHOLD = 5;

/**
 * Knowledge Engineering Division (service "knowledge"). `playbook` pulls
 * related lessons from Memory on demand, synthesizes them into a structured
 * playbook, and files it back into Memory as reusable knowledge.
 *
 * It also runs continuously: every `reflection.recorded` event from the
 * Learning plugin is buffered by category, and once a category accumulates
 * `AUTO_SYNTH_THRESHOLD` fresh lessons its playbook is automatically rebuilt
 * and re-filed — no one has to remember to ask for it.
 */
export function createKnowledgePlugin(): Plugin {
  const pending = new Map<string, string[]>();

  return {
    manifest: { name: "knowledge", version: "0.1.0", capabilities: ["knowledge"], permissions: ["call:memory"], role: "executor" },
    register(ctx) {
      async function buildPlaybook(topic: string, limit: number) {
        let notes: string[] = [];
        try {
          const hits = (await ctx.call("memory", { op: "search", query: topic, options: { limit } })) as MemoryHit[];
          notes = hits.map((h) => h.record.content);
        } catch {
          /* memory optional — empty playbook if unavailable */
        }

        const playbook = synthesize(topic, notes);
        try {
          await ctx.call("memory", { op: "remember", input: { kind: "semantic", content: `Playbook: ${topic} (${playbook.sections.length} sections)`, metadata: { playbook } } });
        } catch {
          /* memory optional */
        }
        return playbook;
      }

      ctx.on("reflection.recorded", async (payload) => {
        const r = payload as ReflectionEvent;
        if (!r.category || !r.lesson) return;
        const bucket = pending.get(r.category) ?? [];
        bucket.push(r.lesson);
        pending.set(r.category, bucket);
        if (bucket.length >= AUTO_SYNTH_THRESHOLD) {
          pending.set(r.category, []);
          const playbook = await buildPlaybook(r.category, 20);
          await ctx.emit("knowledge.autoRefreshed", { topic: r.category, sections: playbook.sections.length });
        }
      });

      ctx.provide("knowledge", async (payload) => {
        const cmd = payload as { op: "playbook"; topic: string; limit?: number };
        if (cmd.op !== "playbook") throw new Error(`knowledge: unknown op "${(cmd as { op: string }).op}"`);
        return buildPlaybook(cmd.topic, cmd.limit ?? 20);
      });
    },
  };
}
