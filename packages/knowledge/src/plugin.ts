import type { Plugin } from "@atlas/core";
import { synthesize } from "./synth";

interface MemoryHit {
  record: { content: string };
}

/**
 * Knowledge Synthesizer plugin (service "knowledge"). `playbook` pulls related
 * lessons from Memory, synthesizes them into a structured playbook, and files
 * the playbook back into Memory as reusable knowledge.
 */
export function createKnowledgePlugin(): Plugin {
  return {
    manifest: { name: "knowledge", version: "0.1.0", capabilities: ["knowledge"], permissions: ["call:memory"], role: "executor" },
    register(ctx) {
      ctx.provide("knowledge", async (payload) => {
        const cmd = payload as { op: "playbook"; topic: string; limit?: number };
        if (cmd.op !== "playbook") throw new Error(`knowledge: unknown op "${(cmd as { op: string }).op}"`);

        let notes: string[] = [];
        try {
          const hits = (await ctx.call("memory", { op: "search", query: cmd.topic, options: { limit: cmd.limit ?? 20 } })) as MemoryHit[];
          notes = hits.map((h) => h.record.content);
        } catch {
          /* memory optional — empty playbook if unavailable */
        }

        const playbook = synthesize(cmd.topic, notes);
        try {
          await ctx.call("memory", { op: "remember", input: { kind: "semantic", content: `Playbook: ${cmd.topic} (${playbook.sections.length} sections)`, metadata: { playbook } } });
        } catch {
          /* memory optional */
        }
        return playbook;
      });
    },
  };
}
