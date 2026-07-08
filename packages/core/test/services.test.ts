import { describe, it, expect } from "vitest";
import { Atlas, type GuardianLike, type Plugin } from "../src/index";

/** Guardian that allows everything except where a permission gate is explicit. */
function realishGuardian(): GuardianLike {
  const grants = new Map<string, string[]>();
  return {
    grant: (m) => void grants.set(m.name, m.permissions),
    check: (m, action) => {
      const perms = grants.get(m.name) ?? [];
      const ok = perms.some((p) => p === "*" || action === p || (p.endsWith("*") && action.startsWith(p.slice(0, -1))));
      return ok ? { decision: "allow", reason: "ok" } : { decision: "deny", reason: "not permitted" };
    },
  };
}

const provider: Plugin = {
  manifest: { name: "provider", version: "1", capabilities: ["math"], permissions: ["*"], role: "executor" },
  register(ctx) {
    ctx.provide("math", (payload) => {
      const { a, b } = payload as { a: number; b: number };
      return a + b;
    });
  },
};

describe("service registry (provide / call)", () => {
  it("lets one plugin call a service another provides", async () => {
    const atlas = new Atlas({ guardian: realishGuardian() });
    await atlas.use(provider);

    let sum: unknown;
    await atlas.use({
      manifest: { name: "consumer", version: "1", capabilities: [], permissions: ["call:math"], role: "executor" },
      async register(ctx) {
        sum = await ctx.call("math", { a: 2, b: 3 });
      },
    });
    expect(sum).toBe(5);
  });

  it("blocks a plugin that lacks call:<service> permission", async () => {
    const atlas = new Atlas({ guardian: realishGuardian() });
    await atlas.use(provider);

    await expect(
      atlas.use({
        manifest: { name: "sneaky", version: "1", capabilities: [], permissions: [], role: "executor" },
        async register(ctx) {
          await ctx.call("math", { a: 1, b: 1 });
        },
      }),
    ).rejects.toThrow(/Guardian deny/);
  });

  it("lets the owner console invoke a service directly (bypassing the gate)", async () => {
    const atlas = new Atlas({ guardian: realishGuardian() });
    await atlas.use(provider);
    const sum = await atlas.invoke("math", { a: 4, b: 5 });
    expect(sum).toBe(9);
    expect(atlas.audit.entries.some((e) => e.actor === "owner-console" && e.action === "invoke:math")).toBe(true);
  });

  it("refuses to provide a capability the plugin did not declare", async () => {
    const atlas = new Atlas({ guardian: realishGuardian() });
    await expect(
      atlas.use({
        manifest: { name: "liar", version: "1", capabilities: [], permissions: ["*"], role: "executor" },
        register(ctx) {
          ctx.provide("math", () => 0);
        },
      }),
    ).rejects.toThrow(/undeclared capability/);
  });
});
