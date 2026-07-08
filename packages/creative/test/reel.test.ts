import { describe, it, expect } from "vitest";
import { DEFAULT_PERSONA } from "@atlas/personas";
import { buildReel, validateReel, pollinationsUrl, type TextGenerator } from "../src/index";

const fakeGen: TextGenerator = {
  async generate() {
    return { text: "Stop wasting hours on busywork. These three AI tools automate it. The first drafts your emails. The second edits your videos. Try them today." };
  },
};

describe("pollinationsUrl", () => {
  it("builds a valid vertical image URL with the persona seed", () => {
    const url = pollinationsUrl("ai tools cinematic", { width: 1080, height: 1920, seed: 42 });
    expect(url).toContain("https://image.pollinations.ai/prompt/");
    expect(url).toContain("width=1080");
    expect(url).toContain("height=1920");
    expect(url).toContain("seed=42");
  });
});

describe("buildReel", () => {
  it("produces a render-ready, valid Reel", async () => {
    const spec = await buildReel(fakeGen, DEFAULT_PERSONA, "3 AI tools that save hours");
    expect(spec.hook).toMatch(/busywork/i);
    expect(spec.scenes.length).toBeGreaterThanOrEqual(3);
    expect(spec.scenes[0]!.imageUrl).toContain("pollinations");
    expect(spec.voice).toBe(DEFAULT_PERSONA.voice);
    expect(spec.caption).toContain(DEFAULT_PERSONA.handle);
    expect(spec.width).toBe(1080);
    expect(spec.height).toBe(1920);
    expect(validateReel(spec).ok).toBe(true);
  });

  it("keeps hashtags within Instagram's limit", async () => {
    const spec = await buildReel(fakeGen, DEFAULT_PERSONA, "passive income with automation and ai tools");
    expect(spec.hashtags.length).toBeLessThanOrEqual(30);
  });
});

describe("validateReel", () => {
  it("flags a non-vertical aspect ratio", async () => {
    const spec = await buildReel(fakeGen, DEFAULT_PERSONA, "topic");
    const landscape = { ...spec, width: 1920, height: 1080 };
    const res = validateReel(landscape);
    expect(res.ok).toBe(false);
    expect(res.problems.join(" ")).toMatch(/9:16/);
  });
});
