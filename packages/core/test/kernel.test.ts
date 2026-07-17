import { describe, it, expect } from "vitest";
import { EventBus, AuditLog, ConfigVault, Atlas, type GuardianLike, type PluginManifest } from "../src/index";

/** A permissive stand-in Guardian so core can be tested in isolation. */
const allowAll: GuardianLike = {
  grant() {},
  check: (_m: PluginManifest, action: string) =>
    action.startsWith("secret:")
      ? { decision: "deny", reason: "no secrets in test" }
      : { decision: "allow", reason: "test" },
};

describe("EventBus", () => {
  it("delivers to subscribers and supports unsubscribe", async () => {
    const bus = new EventBus();
    const seen: number[] = [];
    const off = bus.on<number>("tick", (n) => void seen.push(n));
    await bus.emit("tick", 1);
    off();
    await bus.emit("tick", 2);
    expect(seen).toEqual([1]);
  });

  it("runs handlers in registration order", async () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.on("e", () => void order.push("a"));
    bus.on("e", () => void order.push("b"));
    await bus.emit("e", null);
    expect(order).toEqual(["a", "b"]);
  });
});

describe("AuditLog", () => {
  it("stamps a timestamp and stores entries", async () => {
    const log = new AuditLog();
    const e = await log.record({ actor: "kernel", action: "x", decision: "allow" });
    expect(e.timestamp).toBeTruthy();
    expect(log.entries).toHaveLength(1);
  });
});

describe("ConfigVault", () => {
  it("reads non-secret config but never leaks secrets via get()", () => {
    const c = new ConfigVault({});
    c.set("public", "yes");
    c.set("API_KEY", "sk-123", { secret: true });
    expect(c.get("public")).toBe("yes");
    expect(c.get("API_KEY")).toBeUndefined();
    expect(c._getSecret("API_KEY")).toBe("sk-123");
  });
});

describe("Atlas kernel", () => {
  it("refuses to load the same plugin twice", async () => {
    const atlas = new Atlas({ guardian: allowAll });
    const plugin = { manifest: { name: "dup", version: "1", capabilities: [], permissions: ["*"], role: "executor" as const }, register() {} };
    await atlas.use(plugin);
    await expect(atlas.use(plugin)).rejects.toThrow(/already loaded/);
  });

  it("does NOT run an action's callback when the Guardian denies it", async () => {
    const denyAll: GuardianLike = { grant() {}, check: () => ({ decision: "deny", reason: "nope" }) };
    const atlas = new Atlas({ guardian: denyAll });
    let ran = false;
    await atlas.use({
      manifest: { name: "d", version: "1", capabilities: [], permissions: [], role: "executor" },
      async register(ctx) {
        const r = await ctx.act("anything", async () => { ran = true; });
        expect(r.decision).toBe("deny");
      },
    });
    expect(ran).toBe(false);
  });

  it("still logs a failed completion entry when act()'s run callback throws", async () => {
    const atlas = new Atlas({ guardian: allowAll });
    await atlas.use({
      manifest: { name: "thrower", version: "1", capabilities: [], permissions: [], role: "executor" },
      async register(ctx) {
        await expect(ctx.act("risky-thing", async () => {
          throw new Error("boom");
        })).rejects.toThrow("boom");
      },
    });
    const entries = atlas.audit.entries.filter((e) => e.action === "risky-thing");
    // Before this fix: 0 entries (the throw skipped the only completion log).
    expect(entries.some((e) => e.status === "failed" && e.error?.includes("boom"))).toBe(true);
  });

  it("tags a successful act() completion with status: done", async () => {
    const atlas = new Atlas({ guardian: allowAll });
    await atlas.use({
      manifest: { name: "ok-plugin", version: "1", capabilities: [], permissions: [], role: "executor" },
      async register(ctx) {
        const r = await ctx.act("safe-thing", async () => "value");
        expect(r.decision).toBe("allow");
      },
    });
    const entries = atlas.audit.entries.filter((e) => e.action === "safe-thing");
    expect(entries.some((e) => e.status === "done" && e.outcome === "ok")).toBe(true);
  });
});
