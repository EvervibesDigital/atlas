import type { Plugin } from "@atlas/core";
import type { PersonaCommand } from "./types";
import { PersonaRegistry } from "./registry";

/** Personas plugin — exposes the "personas" service (get / list). */
export function createPersonasPlugin(opts: { registry?: PersonaRegistry } = {}): Plugin {
  return {
    manifest: {
      name: "personas",
      version: "0.1.0",
      capabilities: ["personas"],
      permissions: [],
      role: "executor",
    },

    register(ctx) {
      const registry = opts.registry ?? new PersonaRegistry();
      ctx.provide("personas", (payload) => {
        const cmd = payload as PersonaCommand;
        if (cmd.op === "get") return registry.get(cmd.handle);
        if (cmd.op === "list") return registry.list();
        throw new Error(`personas: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
