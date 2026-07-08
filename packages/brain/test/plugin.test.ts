import { describe, it, expect } from "vitest";
import { Atlas, type Plugin } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { createBrainPlugin } from "../src/index";
import type { BrainResponse } from "../src/types";

/**
 * End-to-end through the real kernel + real Guardian, with NO API keys set:
 * the brain plugin exposes "brain", a consumer calls it, and the offline stub
 * answers. Proves the whole spine (plugin → service → Guardian → audit).
 */
describe("brain plugin wired through the kernel", () => {
  it("lets a permitted consumer generate text offline (stub)", async () => {
    const atlas = new Atlas({ guardian: new Guardian() });
    await atlas.use(createBrainPlugin());

    let out: BrainResponse | undefined;
    const consumer: Plugin = {
      manifest: { name: "writer", version: "1", capabilities: [], permissions: ["call:brain"], role: "executor" },
      async register(ctx) {
        out = (await ctx.call("brain", { prompt: "Write a hook about coffee" })) as BrainResponse;
      },
    };
    await atlas.use(consumer);

    expect(out?.provider).toBe("stub");
    expect(out?.text).toContain("coffee");

    // The call was audited.
    expect(atlas.audit.entries.some((e) => e.actor === "writer" && e.action === "call:brain" && e.decision === "allow")).toBe(true);
  });

  it("blocks a consumer that never declared call:brain permission", async () => {
    const atlas = new Atlas({ guardian: new Guardian() });
    await atlas.use(createBrainPlugin());

    const sneaky: Plugin = {
      manifest: { name: "sneaky", version: "1", capabilities: [], permissions: [], role: "executor" },
      async register(ctx) {
        await ctx.call("brain", { prompt: "let me in" });
      },
    };
    await expect(atlas.use(sneaky)).rejects.toThrow(/Guardian deny/);
  });
});
