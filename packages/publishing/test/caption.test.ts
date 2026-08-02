import { describe, it, expect } from "vitest";
import { captionHook, hookKey, captionProblem, duplicateOf, previewCaption } from "../src/caption";

/**
 * Verbatim from the 50 pending Reel approvals in production on 2026-08-02.
 * Note what these are NOT: the apparent mid-hashtag truncation in the stored
 * approvals was the 120-char PREVIEW, not the caption. The real defect in that
 * queue was repetition — 15 distinct hooks across 50 posts.
 */
const HOOK_A = "Stop trading your hours for dollars.\n\nFollow @everspark.ai for more.\n\n#aitools #automation #solopreneur #passiveincome";
const HOOK_B = "You are building a prison, not a business.\n\nFollow @everspark.ai for more.\n\n#aitools #automation #solopreneur";

describe("duplicateOf — the defect that was actually there", () => {
  it("catches the 19x repeat that was sitting in the queue", () => {
    expect(duplicateOf(HOOK_A, Array(19).fill(HOOK_A))).toBe("Stop trading your hours for dollars.");
  });

  it("lets a genuinely new hook through", () => {
    expect(duplicateOf(HOOK_B, [HOOK_A])).toBeNull();
  });

  it("catches a repost disguised by casing and punctuation", () => {
    expect(duplicateOf("Stop trading your HOURS for dollars!", [HOOK_A])).toBeTruthy();
  });

  it("keeps genuinely different hooks distinct", () => {
    // These two both appeared in the real queue and are separate posts.
    expect(hookKey("Stop trading your hours for dollars.")).not.toBe(hookKey("Stop trading your time for money."));
  });

  it("returns null on an empty queue", () => {
    expect(duplicateOf(HOOK_B, [])).toBeNull();
  });
});

describe("captionProblem", () => {
  it("accepts a real caption", () => {
    expect(captionProblem(HOOK_A)).toBeNull();
  });

  it("does NOT invent a truncation rule — the hashtags were never broken", () => {
    // A gate built on the 120-char preview artifact would reject every good
    // caption forever.
    expect(captionProblem("Hook.\n\n#aitools #automation #solopreneur #passiveincome #")).toBeNull();
  });

  it("rejects an empty caption rather than queueing a blank post", () => {
    expect(captionProblem("   ")).toMatch(/empty/);
  });
});

describe("captionHook", () => {
  it("reads the first line — what a viewer sees repeat", () => {
    expect(captionHook(HOOK_A)).toBe("Stop trading your hours for dollars.");
  });
});

describe("previewCaption", () => {
  it("leaves the real caption alone — it is 118 chars, under the limit", () => {
    // Worth pinning: the production captions were never actually too long.
    expect(HOOK_A.length).toBeLessThan(120);
    expect(previewCaption(HOOK_A)).toBe(HOOK_A);
  });

  it("marks a genuinely cut preview so it cannot be mistaken for a broken caption", () => {
    // The old slice(0,120) cut mid-hashtag and looked like a failed
    // generation — convincingly enough that it was mistaken for one.
    const p = previewCaption(HOOK_A, 60);
    expect(p.endsWith("…")).toBe(true);
    expect(p.length).toBeLessThanOrEqual(60);
  });

  it("cuts on a whitespace boundary, never mid-word or mid-hashtag", () => {
    // Ending ON a complete hashtag is fine; ending PART WAY THROUGH one is the
    // thing that made a healthy queue look broken.
    for (const max of [50, 70, 90, 110]) {
      const p = previewCaption(HOOK_A, max);
      const body = p.slice(0, -1);
      expect(HOOK_A.startsWith(body), `not a prefix at max=${max}`).toBe(true);
      // The original must continue with whitespace, i.e. we stopped at a gap.
      expect(HOOK_A.slice(body.length, body.length + 1), `mid-token cut at max=${max}`).toMatch(/\s/);
    }
  });

  it("leaves a short caption completely alone", () => {
    expect(previewCaption("Short and done.")).toBe("Short and done.");
  });

  it("still returns something useful when there is no word boundary to cut on", () => {
    const long = "x".repeat(300);
    expect(previewCaption(long, 50)).toHaveLength(50);
  });
});
