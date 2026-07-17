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

  it("records a running->done run pair with matching id and a duration on success", async () => {
    const atlas = new Atlas({ guardian: realishGuardian() });
    await atlas.use(provider);
    await atlas.invoke("math", { a: 1, b: 2 });

    const runs = atlas.audit.entries.filter((e) => e.action === "invoke:math");
    expect(runs).toHaveLength(2);
    expect(runs[0]!.status).toBe("running");
    expect(runs[1]!.status).toBe("done");
    expect(runs[0]!.id).toBe(runs[1]!.id);
    expect(typeof runs[1]!.durationMs).toBe("number");
  });

  it("records a running->failed run pair with the error when the service throws", async () => {
    const atlas = new Atlas({ guardian: realishGuardian() });
    await atlas.use({
      manifest: { name: "boom", version: "1", capabilities: ["boom"], permissions: ["*"], role: "executor" },
      register(ctx) {
        ctx.provide("boom", () => {
          throw new Error("kaboom");
        });
      },
    });

    await expect(atlas.invoke("boom", {})).rejects.toThrow("kaboom");
    const runs = atlas.audit.entries.filter((e) => e.action === "invoke:boom");
    expect(runs).toHaveLength(2);
    expect(runs[0]!.status).toBe("running");
    expect(runs[1]!.status).toBe("failed");
    expect(runs[1]!.error).toMatch(/kaboom/);
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

  it("records a running->done run pair when one plugin calls another's service", async () => {
    const atlas = new Atlas({ guardian: realishGuardian() });
    await atlas.use(provider);
    await atlas.use({
      manifest: { name: "consumer", version: "1", capabilities: [], permissions: ["call:math"], role: "executor" },
      async register(ctx) {
        await ctx.call("math", { a: 2, b: 3 });
      },
    });

    const runs = atlas.audit.entries.filter((e) => e.action === "call:math" && e.actor === "consumer");
    expect(runs).toHaveLength(2);
    expect(runs[0]!.status).toBe("running");
    expect(runs[1]!.status).toBe("done");
    expect(runs[0]!.id).toBe(runs[1]!.id);
  });
});
