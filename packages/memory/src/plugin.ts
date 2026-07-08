import type { Plugin } from "@atlas/core";
import type { Embedder, MemoryCommand, MemoryStore } from "./types";
import { Memory } from "./memory";
import { JsonFileStore } from "./stores";

/**
 * Memory plugin — exposes the "memory" service. Other plugins call it with a
 * command object: { op: "remember" | "search" | "recent" | "forget", ... }.
 *
 * By default it persists to a JSON file (offline, no database). Inject a
 * different store/embedder for tests or for the future pgvector backend.
 */
export function createMemoryPlugin(opts: { store?: MemoryStore; embedder?: Embedder; file?: string } = {}): Plugin {
  return {
    manifest: {
      name: "memory",
      version: "0.1.0",
      capabilities: ["memory"],
      permissions: [],
      role: "executor",
    },

    async register(ctx) {
      const store = opts.store ?? new JsonFileStore(opts.file ?? ctx.config("MEMORY_FILE") ?? "./data/memory.json");
      const memory = new Memory(store, opts.embedder);

      ctx.provide("memory", (payload) => {
        const cmd = payload as MemoryCommand;
        switch (cmd.op) {
          case "remember":
            return memory.remember(cmd.input);
          case "search":
            return memory.search(cmd.query, cmd.options);
          case "recent":
            return memory.recent(cmd.kind, cmd.limit);
          case "forget":
            return memory.forget(cmd.id);
          default:
            throw new Error(`memory: unknown op "${(cmd as { op: string }).op}"`);
        }
      });

      await ctx.emit("memory.ready", {});
    },
  };
}
