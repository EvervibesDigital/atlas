import { writeFile, mkdir } from "node:fs/promises";
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
