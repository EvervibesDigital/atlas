import { describe, it, expect } from "vitest";
import { deriveTopic, reelToPublishInput, type ReelLike } from "../src/index";

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
