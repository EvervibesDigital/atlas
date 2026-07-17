import { describe, it, expect } from "vitest";
import { MontageRenderer } from "../src/montage-renderer";

describe("MontageRenderer", () => {
  it("reports not ready when Piper isn't configured", () => {
    const r = new MontageRenderer({ tempDir: "." });
    expect(r.piperReady).toBe(false);
  });

  it("reports ready once both piperBin and piperModel are set", () => {
    const r = new MontageRenderer({ tempDir: ".", piperBin: "/usr/local/bin/piper", piperModel: "/models/en.onnx" });
    expect(r.piperReady).toBe(true);
  });

  it("behaves like NoOpRenderer (returns empty string) when Piper isn't configured, instead of crashing", async () => {
    const r = new MontageRenderer({ tempDir: "." });
    const out = await r.render({ voice: "en-US-AriaNeural", scenes: [{ text: "hi", imageUrl: "https://example.com/x.jpg" }] });
    expect(out).toBe("");
  });
});
