import { describe, it, expect } from "vitest";
import { deriveTopic, reelToPublishInput, optional, type ReelLike, type CycleHealthTracker } from "../src/index";

describe("deriveTopic", () => {
  it("rotates through pillars by day so topics vary", () => {
    const pillars = ["ai tools", "automation", "passive income"];
    expect(deriveTopic(pillars, 0)).toBe("ai tools tips");
    expect(deriveTopic(pillars, 1)).toBe("automation tips");
    expect(deriveTopic(pillars, 3)).toBe("ai tools tips"); // wraps around
  });

  it("falls back when there are no pillars", () => {
    expect(deriveTopic([], 5)).toBe("AI tools and automation");
  });
});

describe("reelToPublishInput", () => {
  it("carries video ref and reel fields through", () => {
    const reel: ReelLike = { personaHandle: "@x", hook: "h", caption: "c", hashtags: ["a"], width: 1080, height: 1920, estDurationSec: 30 };
    const input = reelToPublishInput(reel, "reel.mp4");
    expect(input.videoRef).toBe("reel.mp4");
    expect(input.durationSec).toBe(30);
    expect(input.width).toBe(1080);
  });
});

describe("optional() step runner", () => {
  function tracker(): CycleHealthTracker {
    return { succeeded: 0, failures: [] };
  }

  it("returns the result and counts a success when the call resolves", async () => {
    const t = tracker();
    const call = async () => ({ ok: true });
    const result = await optional(call, "svc", {}, t);
    expect(result).toEqual({ ok: true });
    expect(t.succeeded).toBe(1);
    expect(t.failures).toHaveLength(0);
  });

  it("records a failure and returns undefined when the call throws", async () => {
    const t = tracker();
    const call = async () => { throw new Error("boom"); };
    const result = await optional(call, "svc", {}, t);
    expect(result).toBeUndefined();
    expect(t.succeeded).toBe(0);
    expect(t.failures).toEqual([{ step: "svc", error: "boom" }]);
  });

  it("times out a hanging call instead of waiting forever, and records it as a failure", async () => {
    const t = tracker();
    const call = () => new Promise(() => { /* never resolves */ });
    const result = await optional(call, "svc", {}, t, 30);
    expect(result).toBeUndefined();
    expect(t.succeeded).toBe(0);
    expect(t.failures).toHaveLength(1);
    expect(t.failures[0]!.step).toBe("svc");
    expect(t.failures[0]!.error).toMatch(/timed out/);
  });

  it("runs several steps in parallel, taking roughly the slowest single step, not their sum", async () => {
    const t = tracker();
    const slowCall = (ms: number) => () => new Promise((resolve) => setTimeout(() => resolve("done"), ms));
    const started = Date.now();
    await Promise.all([
      optional(slowCall(40), "a", {}, t),
      optional(slowCall(40), "b", {}, t),
      optional(slowCall(40), "c", {}, t),
    ]);
    const elapsed = Date.now() - started;
    // Sequential would take ~120ms; parallel should take ~40ms. 90ms is a
    // generous ceiling that would fail if these ran sequentially but easily
    // passes if they ran in parallel, without being a flaky tight bound.
    expect(elapsed).toBeLessThan(90);
    expect(t.succeeded).toBe(3);
  });
});
