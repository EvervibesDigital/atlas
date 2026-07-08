import { describe, it, expect } from "vitest";
import { Atlas, type Plugin } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { createPersonasPlugin, PersonaRegistry, DEFAULT_PERSONA, type Persona } from "../src/index";

describe("personas plugin", () => {
  it("returns the default persona by handle", async () => {
    const atlas = new Atlas({ guardian: new Guardian() });
    await atlas.use(createPersonasPlugin({ registry: new PersonaRegistry() }));

    let got: Persona | undefined;
    await atlas.use({
      manifest: { name: "c", version: "1", capabilities: [], permissions: ["call:personas"], role: "executor" },
      async register(ctx) {
        got = (await ctx.call("personas", { op: "get", handle: DEFAULT_PERSONA.handle })) as Persona;
      },
    } satisfies Plugin);

    expect(got?.handle).toBe(DEFAULT_PERSONA.handle);
    expect(got?.platforms).toContain("instagram-reels");
  });
});
