import { describe, it, expect } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveGeneratedImage } from "../src/images";

describe("saveGeneratedImage", () => {
  it("writes the decoded bytes under <dir>/<creatorId>/<contentItemId>.<ext> and returns that relative path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-mf-images-"));
    try {
      const base64 = Buffer.from("hello image bytes").toString("base64");
      const rel = await saveGeneratedImage(dir, "creator-1", "content-9", { mimeType: "image/jpeg", base64 });
      expect(rel).toBe(join("creator-1", "content-9.jpg"));
      const written = await readFile(join(dir, rel), "utf8");
      expect(written).toBe("hello image bytes");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("picks the right extension per mime type, defaulting to png for unknown types", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-mf-images-"));
    try {
      const b64 = Buffer.from("x").toString("base64");
      expect(await saveGeneratedImage(dir, "c", "a", { mimeType: "image/png", base64: b64 })).toMatch(/\.png$/);
      expect(await saveGeneratedImage(dir, "c", "b", { mimeType: "image/webp", base64: b64 })).toMatch(/\.webp$/);
      expect(await saveGeneratedImage(dir, "c", "d", { mimeType: "image/gif", base64: b64 })).toMatch(/\.png$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
