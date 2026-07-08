import type { Plugin } from "@atlas/core";

/**
 * hello — the Phase 0 proof plugin. It exists only to prove the kernel frame
 * holds end-to-end:
 *   1. it loads,
 *   2. it emits an event other modules can hear,
 *   3. a permitted action runs and is audited,
 *   4. a forbidden action (a planner trying to execute) is BLOCKED by the
 *      Guardian before it can run.
 *
 * It is a `planner`, so Seam 1 (planners cannot execute) applies to it.
 */
export const helloPlugin: Plugin = {
  manifest: {
    name: "hello",
    version: "0.0.1",
    capabilities: ["demo.greeting"],
    permissions: ["demo.*"],
    role: "planner",
  },

  async register(ctx) {
    // 3. A permitted action — the Guardian allows "demo.*", so this runs.
    await ctx.act("demo.greet", async () => {
      // 2. Announce ourselves on the bus so any listener can react.
      await ctx.emit("hello.greeted", { from: ctx.plugin.name, message: "ATLAS is alive." });
      return "greeted";
    });

    // 4. A forbidden action — a planner attempting to execute. The Guardian
    //    denies this BEFORE the callback runs (the callback must never fire).
    await ctx.act("execute.something", async () => {
      throw new Error("this must never run — the Guardian should have blocked it");
    });
  },
};
