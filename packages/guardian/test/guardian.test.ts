import { describe, it, expect } from "vitest";
import type { PluginManifest } from "@atlas/core";
import { Guardian } from "../src/index";

function manifest(over: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name: "t",
    version: "1",
    capabilities: [],
    permissions: ["demo.*"],
    role: "executor",
    ...over,
  };
}

describe("Guardian", () => {
  it("denies plugins with no grant recorded", () => {
    const g = new Guardian();
    expect(g.check(manifest(), "demo.greet").decision).toBe("deny");
  });

  it("allows a permitted action once granted", () => {
    const g = new Guardian();
    const m = manifest();
    g.grant(m);
    expect(g.check(m, "demo.greet").decision).toBe("allow");
  });

  it("denies an action outside declared permissions", () => {
    const g = new Guardian();
    const m = manifest({ permissions: ["demo.greet"] });
    g.grant(m);
    expect(g.check(m, "demo.other").decision).toBe("deny");
  });

  it("Seam 1: a planner cannot execute", () => {
    const g = new Guardian();
    const m = manifest({ role: "planner", permissions: ["*"] });
    g.grant(m);
    const v = g.check(m, "execute.deploy");
    expect(v.decision).toBe("deny");
    expect(v.reason).toMatch(/planner/);
  });

  it("Seam 2: an executor cannot change policy", () => {
    const g = new Guardian();
    const m = manifest({ role: "executor", permissions: ["*"] });
    g.grant(m);
    const v = g.check(m, "policy.update");
    expect(v.decision).toBe("deny");
    expect(v.reason).toMatch(/executor/);
  });

  it("forces human approval for high-risk actions even with wildcard permission", () => {
    const g = new Guardian();
    const m = manifest({ role: "executor", permissions: ["*"] });
    g.grant(m);
    expect(g.check(m, "purchase").decision).toBe("pending");
    expect(g.check(m, "money.transfer").decision).toBe("pending");
    expect(g.check(m, "file.delete").decision).toBe("pending");
  });

  it("supports wildcard, prefix, and exact permission matching", () => {
    const g = new Guardian();
    const exact = manifest({ permissions: ["a.b"] });
    const prefix = manifest({ name: "p", permissions: ["a.*"] });
    const star = manifest({ name: "s", permissions: ["*"] });
    [exact, prefix, star].forEach((m) => g.grant(m));
    expect(g.check(exact, "a.b").decision).toBe("allow");
    expect(g.check(exact, "a.c").decision).toBe("deny");
    expect(g.check(prefix, "a.anything").decision).toBe("allow");
    expect(g.check(star, "z.z").decision).toBe("allow");
  });
});
