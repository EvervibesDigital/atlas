import { describe, it, expect } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveGeneratedImage, findReferenceImage } from "../src/images";

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

describe("findReferenceImage", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64");

  it("returns null before a creator has any image", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-mf-ref-"));
    try {
      expect(await findReferenceImage(dir, "nobody")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("anchors on the OLDEST image so the persona cannot drift", async () => {
    // Referencing the newest image chains each generation off the last, and
    // small deviations compound — after a dozen posts the persona has quietly
    // become someone else. Every generation must sit one step from the same
    // original face, not N steps down a chain.
    const dir = await mkdtemp(join(tmpdir(), "atlas-mf-ref-"));
    try {
      await saveGeneratedImage(dir, "c1", "first", { mimeType: "image/png", base64: b64("canonical face") });
      await new Promise((r) => setTimeout(r, 12)); // distinct mtimes
      await saveGeneratedImage(dir, "c1", "second", { mimeType: "image/png", base64: b64("later drifted face") });

      const ref = await findReferenceImage(dir, "c1");
      expect(Buffer.from(ref!.base64, "base64").toString()).toBe("canonical face");
      expect(ref!.mimeType).toBe("image/png");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports the mime type from the extension it actually saved", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-mf-ref-"));
    try {
      await saveGeneratedImage(dir, "c2", "only", { mimeType: "image/jpeg", base64: b64("jpg bytes") });
      expect((await findReferenceImage(dir, "c2"))!.mimeType).toBe("image/jpeg");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores non-image files sitting in the folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-mf-ref-"));
    try {
      await saveGeneratedImage(dir, "c3", "img", { mimeType: "image/png", base64: b64("real image") });
      const { writeFile: wf } = await import("node:fs/promises");
      await wf(join(dir, "c3", "notes.txt"), "not an image");
      const ref = await findReferenceImage(dir, "c3");
      expect(Buffer.from(ref!.base64, "base64").toString()).toBe("real image");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
