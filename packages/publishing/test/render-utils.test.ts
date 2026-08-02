import { describe, it, expect } from "vitest";
import { wrapText, parseFfmpegDuration, reviewRender, buildSrt, buildConcatFileContent, kenBurnsFilter, buildMusicBedFilter } from "../src/render-utils";

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

describe("buildSrt", () => {
  it("produces a single SRT cue spanning the full duration", () => {
    const srt = buildSrt("hello world", 5.32, 35);
    expect(srt).toContain("1\n");
    expect(srt).toContain("00:00:00,000 --> 00:00:05,320\n");
    expect(srt).toContain("hello world");
  });
  it("wraps long text onto multiple lines within the cue", () => {
    const srt = buildSrt("this is a fairly long sentence that should wrap onto more than one line", 3, 20);
    const bodyLines = srt.split("\n").slice(2).filter(Boolean);
    expect(bodyLines.length).toBeGreaterThan(1);
    for (const l of bodyLines) expect(l.length).toBeLessThanOrEqual(20 + 10);
  });
});

describe("buildConcatFileContent", () => {
  it("writes bare filenames, not the run-directory-prefixed path", () => {
    // ffmpeg's concat demuxer resolves relative entries against the list
    // file's OWN directory. Writing the full runDir-prefixed path here (the
    // actual bug that shipped) makes ffmpeg double the directory prefix and
    // fail with "No such file or directory" on every single render.
    const content = buildConcatFileContent(["data/temp/montage-abc123/segment_0.mp4", "data/temp/montage-abc123/segment_1.mp4"]);
    expect(content).toBe("file 'segment_0.mp4'\nfile 'segment_1.mp4'");
    expect(content).not.toContain("data/temp");
  });

  it("converts backslashes to forward slashes for ffmpeg's concat syntax", () => {
    const content = buildConcatFileContent(["data\\temp\\montage-abc123\\segment_0.mp4"]);
    expect(content).toBe("file 'segment_0.mp4'");
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

describe("kenBurnsFilter", () => {
  it("supersamples before zooming, then outputs at the target size", () => {
    // Without the upscale, zoompan's integer-pixel crop makes the motion
    // visibly stair-step — the whole reason to add motion is undone.
    const f = kenBurnsFilter({ index: 0, durationSec: 4, width: 1080, height: 1920 });
    expect(f.indexOf("scale=2160:3840")).toBe(0);
    expect(f).toContain("crop=2160:3840");
    expect(f).toContain("s=1080x1920");
    expect(f.indexOf("scale=2160:3840")).toBeLessThan(f.indexOf("zoompan"));
  });

  it("fills the vertical frame from any source aspect instead of letterboxing", () => {
    expect(kenBurnsFilter({ index: 0, durationSec: 4, width: 1080, height: 1920 }))
      .toContain("force_original_aspect_ratio=increase");
  });

  it("lands on exactly maxZoom at the last frame, whatever the duration", () => {
    // Drives zoom off the output frame number rather than accumulating the
    // previous frame's zoom, so scenes of different lengths end up matched.
    for (const durationSec of [1.5, 4, 9.25]) {
      const f = kenBurnsFilter({ index: 0, durationSec, width: 1080, height: 1920, maxZoom: 1.12 });
      const m = f.match(/z='1\+([0-9.]+)\*on\/(\d+)'/);
      expect(m, `no linear zoom expression for ${durationSec}s`).toBeTruthy();
      const span = Number(m![1]);
      const frames = Number(m![2]);
      expect(frames).toBe(Math.round(durationSec * 30));
      // z = 1 + span * on/frames, so the final frame (on === frames) is 1 + span.
      const zoomAtLastFrame = 1 + span * (frames / frames);
      expect(zoomAtLastFrame).toBeCloseTo(1.12, 5);
    }
  });

  it("never divides by zero on a scene shorter than one frame", () => {
    const f = kenBurnsFilter({ index: 0, durationSec: 0, width: 1080, height: 1920 });
    expect(f).toContain("/1'");
    expect(f).not.toContain("/0");
  });

  it("rotates through three motions so a reel does not pulse on a two-beat loop", () => {
    const motions = [0, 1, 2, 3].map((index) => kenBurnsFilter({ index, durationSec: 4, width: 1080, height: 1920 }));
    expect(new Set(motions).size).toBe(3);
    expect(motions[0]).toBe(motions[3]);
    expect(motions[1]).toContain("1.12-");
    expect(motions[2]).toContain("(ih-ih/zoom)*on/");
  });
});

describe("buildMusicBedFilter", () => {
  it("ducks the MUSIC under the narration, not the other way round", () => {
    // sidechaincompress compresses its FIRST input using the SECOND as the
    // trigger. Swapped, it buries the narration under the music — and still
    // renders perfectly happily, so nothing catches it but this test.
    const f = buildMusicBedFilter({ durationSec: 30 });
    expect(f).toContain("[bed][0:a]sidechaincompress");
    expect(f).not.toContain("[0:a][bed]sidechaincompress");
  });

  it("mixes to the narration's length, not the looped music's", () => {
    // The bed is loop-extended by the caller, so mixing to the longest input
    // would produce a video that never ends.
    expect(buildMusicBedFilter({ durationSec: 30 })).toContain("duration=first");
  });

  it("places the fade-out relative to the clip's own end", () => {
    expect(buildMusicBedFilter({ durationSec: 30, fadeOutSec: 2 })).toContain("st=28.00:d=2");
  });

  it("never starts a fade before zero on a clip shorter than the fade", () => {
    const f = buildMusicBedFilter({ durationSec: 1, fadeOutSec: 3 });
    expect(f).toContain("st=0.00");
    expect(f).not.toMatch(/st=-/);
  });

  it("does not let amix attenuate the narration", () => {
    // amix divides by input count by default, so adding a bed made the VOICE
    // 6 dB quieter — measured -27.1 dB against -21.1 dB over the same window
    // on a real render. ffmpeg exited 0 and the file was valid; the voice was
    // just harder to hear. With normalize=0 the same window measures -20.6 dB.
    const f = buildMusicBedFilter({ durationSec: 30 });
    expect(f).toContain("normalize=0");
  });

  it("limits the summed output, since un-normalized mixing can clip", () => {
    expect(buildMusicBedFilter({ durationSec: 30 })).toMatch(/alimiter=limit=0\.9\d/);
  });

  it("keeps the bed well under unity so it cannot swamp speech", () => {
    const volume = Number(buildMusicBedFilter({ durationSec: 30 }).match(/volume=([\d.]+)/)![1]);
    expect(volume).toBeGreaterThan(0);
    expect(volume).toBeLessThan(0.4);
  });
});
