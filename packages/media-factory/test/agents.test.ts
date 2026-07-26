import { describe, it, expect } from "vitest";
import { buildImagePrompt } from "../src/agents";
import type { VirtualCreator } from "../src/db";

function creator(appearance?: { description?: string }): VirtualCreator {
  return {
    name: "Aria Vance",
    handle: "ariavance",
    age_range: "24-28",
    gender: "Female",
    appearance_profile: appearance,
    personality_traits: [],
    speaking_style: "",
    humor_style: "",
    values_statement: "",
    background_story: "",
    interests: [],
    content_pillars: [],
    target_audience: {},
    brand_positioning: "",
  };
}

describe("buildImagePrompt", () => {
  it("prefixes the locked character-sheet description onto the scene prompt", () => {
    const c = creator({ description: "A woman with shoulder-length wavy chestnut-brown hair, green eyes." });
    const prompt = buildImagePrompt(c, "sitting at a desk with a laptop, tech workspace");
    expect(prompt).toContain("shoulder-length wavy chestnut-brown hair");
    expect(prompt).toContain("Scene: sitting at a desk with a laptop, tech workspace");
    expect(prompt).toContain("MUST match the physical description above");
  });

  it("falls back to just the scene prompt when the creator has no character sheet yet", () => {
    const c = creator(undefined);
    expect(buildImagePrompt(c, "a scene")).toBe("a scene");
  });

  it("falls back when the description is present but empty/whitespace", () => {
    const c = creator({ description: "   " });
    expect(buildImagePrompt(c, "a scene")).toBe("a scene");
  });
});
