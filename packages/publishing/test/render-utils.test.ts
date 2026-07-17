import { describe, it, expect } from "vitest";
import { wrapText, parseFfmpegDuration, reviewRender } from "../src/render-utils";

describe("wrapText", () => {
  it("wraps long text into multiple lines under maxLen", () => {
    const wrapped = wrapText("this is a fairly long sentence that should wrap onto more than one line", 20);
    const lines = wrapped.split("\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(20 + 10);
  });
  it("escapes single quotes for ffmpeg filter syntax", () => {
    expect(wrapText("it's fine", 100)).toContain("\\\\''");
  });
});

describe("parseFfmpegDuration", () => {
  it("parses a standard ffmpeg Duration line", () => {
    const stderr = "Input #0, wav\n  Duration: 00:00:05.32, bitrate: 128 kb/s";
    expect(parseFfmpegDuration(stderr)).toBeCloseTo(5.32, 2);
  });
  it("returns null when no Duration line is present", () => {
    expect(parseFfmpegDuration("no duration here")).toBeNull();
  });
});

describe("reviewRender", () => {
  it("passes a healthy render", () => {
    const r = reviewRender({ sizeBytes: 500_000, durationSec: 12, expectedScenes: 3, expectedMinDurationSec: 4.5 });
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });
  it("flags an empty output file", () => {
    const r = reviewRender({ sizeBytes: 0, durationSec: 12, expectedScenes: 3, expectedMinDurationSec: 4.5 });
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toMatch(/empty/);
  });
  it("flags a suspiciously short render", () => {
    const r = reviewRender({ sizeBytes: 500_000, durationSec: 1, expectedScenes: 3, expectedMinDurationSec: 4.5 });
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toMatch(/shorter than/);
  });
});
