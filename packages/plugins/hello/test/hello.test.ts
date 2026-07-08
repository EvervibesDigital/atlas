import { describe, it, expect } from "vitest";
import { Atlas } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { helloPlugin } from "../src/index";

/**
 * PHASE 0 DEPENDABILITY GATE.
 * The frame is only "done" when all four of these hold together.
 */
describe("Phase 0 dependability gate: the hello plugin proves the frame", () => {
  it("loads the plugin", async () => {
    const atlas = new Atlas({ guardian: new Guardian() });
    await atlas.use(helloPlugin);
    expect(atlas.loaded()).toContain("hello");
  });

  it("delivers the plugin's emitted event to a listener", async () => {
    const atlas = new Atlas({ guardian: new Guardian() });
    const heard: unknown[] = [];
    atlas.events.on("hello.greeted", (p) => void heard.push(p));

    await atlas.use(helloPlugin);

    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ from: "hello", message: "ATLAS is alive." });
  });

  it("audits the permitted action AND the emitted event", async () => {
    const atlas = new Atlas({ guardian: new Guardian() });
    await atlas.use(helloPlugin);

    const actions = atlas.audit.entries.map((e) => e.action);
    expect(actions).toContain("demo.greet");
    expect(actions).toContain("emit:hello.greeted");

    const greet = atlas.audit.entries.find((e) => e.action === "demo.greet");
    expect(greet?.decision).toBe("allow");
  });

  it("BLOCKS a planner that tries to execute (Seam 1) and records the denial", async () => {
    const atlas = new Atlas({ guardian: new Guardian() });
    // If the Guardian ever let this through, the plugin's callback throws and
    // this load would reject. It must NOT throw.
    await expect(atlas.use(helloPlugin)).resolves.toBeDefined();

    const denied = atlas.audit.entries.find((e) => e.action === "execute.something");
    expect(denied?.decision).toBe("deny");
    expect(denied?.outcome).toMatch(/planner role cannot execute/);
  });
});
