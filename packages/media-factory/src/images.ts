import { writeFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const EXT_BY_MIME: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/** Save a base64 image to disk under `dir/<creatorId>/<contentItemId>.<ext>`,
 * mirroring @atlas/publishing's MontageRenderer convention (real files on
 * disk, not blobs in the DB). Returns the path written, relative to `dir`. */
export async function saveGeneratedImage(dir: string, creatorId: string, contentItemId: string, image: { mimeType: string; base64: string }): Promise<string> {
  const ext = EXT_BY_MIME[image.mimeType] ?? "png";
  const subdir = join(dir, creatorId);
  await mkdir(subdir, { recursive: true });
  const filename = `${contentItemId}.${ext}`;
  await writeFile(join(subdir, filename), Buffer.from(image.base64, "base64"));
  return join(creatorId, filename);
}

const MIME_BY_EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

/**
 * The image that defines what a creator looks like, for passing back as a
 * reference so their face stays the same across posts.
 *
 * Returns the creator's OLDEST image, deliberately. Referencing the newest
 * would chain each generation off the one before it, and small deviations
 * compound — after a dozen posts the persona has quietly drifted into someone
 * else. Anchoring every generation to the first image keeps them all one step
 * from a single canonical appearance instead of N steps down a chain.
 *
 * Returns null when the creator has no images yet (their first generation has
 * nothing to match, which is correct, not an error).
 */
export async function findReferenceImage(
  dir: string,
  creatorId: string,
): Promise<{ mimeType: string; base64: string } | null> {
  const subdir = join(dir, creatorId);
  let names: string[];
  try {
    names = await readdir(subdir);
  } catch {
    return null; // no folder yet — first ever image for this creator
  }
  const candidates = names.filter((n) => MIME_BY_EXT[n.split(".").pop()?.toLowerCase() ?? ""]);
  if (candidates.length === 0) return null;

  const withTimes = await Promise.all(
    candidates.map(async (name) => ({ name, mtime: (await stat(join(subdir, name))).mtimeMs })),
  );
  // Name as the tiebreak so the choice is deterministic when files share an
  // mtime — otherwise the "canonical" face could change between runs on a
  // filesystem with coarse timestamps.
  withTimes.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
  const oldest = withTimes[0]!;
  const data = await readFile(join(subdir, oldest.name));
  return {
    mimeType: MIME_BY_EXT[oldest.name.split(".").pop()!.toLowerCase()]!,
    base64: data.toString("base64"),
  };
}
