import type { BrowserStep, PublishInput } from "./types";

const CAPTION_MAX = 2200;
const HASHTAG_MAX = 30;
const REEL_MIN_SEC = 3;
const REEL_MAX_SEC = 90;

/**
 * The Instagram Reels posting recipe — declarative browser steps. This is the
 * plan ATLAS WOULD run to post (driving a logged-in browser like a human). It
 * is intentionally data only: nothing here executes until a live browser
 * publisher + Mat's session are wired in.
 */
export const INSTAGRAM_REELS_RECIPE: BrowserStep[] = [
  { action: "goto", url: "https://www.instagram.com/", note: "requires an existing logged-in session" },
  { action: "click", selector: "svg[aria-label='New post']", note: "open the composer" },
  { action: "click", selector: "text=Post" },
  { action: "upload", selector: "input[type='file']", valueFrom: "videoRef", note: "upload the rendered MP4" },
  { action: "waitFor", selector: "text=Reel", note: "IG auto-detects vertical video as a Reel" },
  { action: "click", selector: "text=Next" },
  { action: "click", selector: "text=Next" },
  { action: "fill", selector: "textarea[aria-label='Write a caption...']", valueFrom: "caption" },
  { action: "click", selector: "text=Share", note: "FINAL — only runs after human approval + live publisher" },
];

/** Validate a Reel is postable to Instagram. */
export function validateForInstagram(input: PublishInput): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const ratio = input.width / input.height;
  if (ratio < 0.55 || ratio > 0.58) problems.push(`aspect ratio must be ~9:16 (got ${input.width}x${input.height})`);
  if (input.durationSec < REEL_MIN_SEC || input.durationSec > REEL_MAX_SEC) problems.push(`duration must be ${REEL_MIN_SEC}-${REEL_MAX_SEC}s (got ${input.durationSec}s)`);
  if (input.caption.length > CAPTION_MAX) problems.push(`caption too long (${input.caption.length}/${CAPTION_MAX})`);
  if (input.hashtags.length > HASHTAG_MAX) problems.push(`too many hashtags (${input.hashtags.length}/${HASHTAG_MAX})`);
  if (!input.personaHandle) problems.push("missing persona handle");
  return { ok: problems.length === 0, problems };
}
