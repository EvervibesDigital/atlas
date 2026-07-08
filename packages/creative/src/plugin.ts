import type { Plugin } from "@atlas/core";
import type { Persona } from "@atlas/personas";
import type { CreativeCommand } from "./types";
import { buildReel } from "./reel";

/**
 * Creative plugin — exposes the "creative" service. `writeReel` pulls the
 * persona (personas service), writes the narration (brain service), and returns
 * a render-ready ReelSpec. Role executor; it acts by producing content.
 */
export function createCreativePlugin(): Plugin {
  return {
    manifest: {
      name: "creative",
      version: "0.1.0",
      capabilities: ["creative"],
      permissions: ["call:brain", "call:personas"],
      role: "executor",
    },

    register(ctx) {
      ctx.provide("creative", async (payload) => {
        const cmd = payload as CreativeCommand;
        if (cmd.op !== "writeReel") throw new Error(`creative: unknown op "${(cmd as { op: string }).op}"`);

        const persona = (await ctx.call("personas", { op: "get", handle: cmd.personaHandle })) as Persona | undefined;
        if (!persona) throw new Error(`creative: unknown persona "${cmd.personaHandle}"`);

        const gen = {
          generate: (req: { prompt: string; system?: string; needs?: Record<string, number>; task?: string }) =>
            ctx.call("brain", req) as Promise<{ text: string }>,
        };

        return buildReel(gen, persona, cmd.topic);
      });
    },
  };
}
