import { describe, it, expect } from "vitest";
import { validateForInstagram, DryRunPublisher, INSTAGRAM_REELS_RECIPE, type PublishInput } from "../src/index";

const goodInput: PublishInput = {
  personaHandle: "@everspark.ai",
  videoRef: "reel-123.mp4",
  caption: "Stop wasting hours. #ai #automation",
  hashtags: ["ai", "automation"],
  width: 1080,
  height: 1920,
  durationSec: 32,
};

describe("validateForInstagram", () => {
  it("passes a valid vertical Reel", () => {
    expect(validateForInstagram(goodInput).ok).toBe(true);
  });
  it("rejects a landscape video", () => {
    const res = validateForInstagram({ ...goodInput, width: 1920, height: 1080 });
    expect(res.ok).toBe(false);
    expect(res.problems.join(" ")).toMatch(/9:16/);
  });
  it("rejects an over-long video", () => {
    expect(validateForInstagram({ ...goodInput, durationSec: 120 }).ok).toBe(false);
  });
});

describe("DryRunPublisher", () => {
  it("validates and returns the recipe but does NOT post", async () => {
    const res = await new DryRunPublisher().publish(goodInput);
    expect(res.status).toBe("dry-run");
    expect(res.recipe).toEqual(INSTAGRAM_REELS_RECIPE);
    // The final step is 'Share' — proving posting is defined but gated.
    expect(res.recipe!.at(-1)!.selector).toMatch(/Share/);
  });
  it("returns pending-render when there is no video yet", async () => {
    const res = await new DryRunPublisher().publish({ ...goodInput, videoRef: null });
    expect(res.status).toBe("pending-render");
  });
});
