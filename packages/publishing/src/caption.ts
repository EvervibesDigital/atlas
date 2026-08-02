/**
 * Caption quality gate, applied before a Reel is queued for approval.
 *
 * Measured against the real approval queue on 2026-08-02, which had grown to
 * **50 pending Reels carrying only 15 distinct hooks** — one line repeated 19
 * times, another 9, another 7. The generator had been looping on the same few
 * ideas for two days and nothing noticed, because each individual approval
 * looks perfectly normal. You only see it by reading fifty cards in a row.
 *
 * Posting nineteen near-identical Reels to one Instagram account is what gets
 * accounts actioned, so this refuses at the point the approval is created.
 *
 * ── What this does NOT check, and why ──────────────────────────────────────
 * Those same 50 approvals all appeared to end mid-hashtag ("…#passiveincome
 * #"). That turned out to be an artifact of the approval PREVIEW being capped
 * at 120 characters for display — every stored detail was exactly 120 chars
 * long — not a defect in the caption. There was no truncation bug. A gate
 * built on that reading would have rejected perfectly good captions forever,
 * which is why `previewCaption` below fixes the display instead.
 */

/** The first non-empty line — what a viewer actually reads, and what repeats. */
export function captionHook(caption: string): string {
  for (const line of (caption ?? "").split("\n")) {
    const t = line.trim();
    if (t) return t;
  }
  return "";
}

/**
 * Normalised for comparison, so trivial edits don't disguise a repost.
 * "Stop trading your hours for dollars." and "Stop trading your HOURS for
 * dollars!" are the same post to anyone scrolling.
 */
export function hookKey(caption: string): string {
  return captionHook(caption)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Structural defects in a caption. Returns null when it's fine. */
export function captionProblem(caption: string): string | null {
  const text = (caption ?? "").trim();
  if (!text) return "caption is empty";
  if (!captionHook(text)) return "caption has no readable first line";
  return null;
}

/**
 * Does this caption repeat something already waiting for approval?
 *
 * Compared against the PENDING queue rather than all history on purpose: the
 * same hook months apart is ordinary reuse, but the same hook sitting unposted
 * nineteen times over is a generator stuck in a loop.
 */
export function duplicateOf(caption: string, pendingCaptions: string[]): string | null {
  const key = hookKey(caption);
  if (!key) return null;
  for (const existing of pendingCaptions) {
    if (hookKey(existing) === key) return captionHook(existing);
  }
  return null;
}

/**
 * A caption preview for an approval card.
 *
 * The old `caption.slice(0, 120)` cut mid-word and mid-hashtag, which made
 * every queued Reel look like a broken generation — convincingly enough that
 * it was mistaken for one. Cutting on a word boundary and marking the cut with
 * an ellipsis makes it unmistakably a preview rather than the caption itself.
 */
export function previewCaption(caption: string, max = 120): string {
  const text = (caption ?? "").trim();
  if (text.length <= max) return text;
  const slice = text.slice(0, max - 1);
  // Any whitespace is a boundary, not just a space — captions are multi-line,
  // and cutting on spaces alone would still slice a hashtag in half whenever
  // the limit landed on the line that holds them.
  const lastBoundary = slice.search(/\s[^\s]*$/);
  // Only honour the boundary if it isn't so early that the preview loses its
  // point; otherwise a single long token would leave almost nothing.
  const cut = lastBoundary > max * 0.6 ? slice.slice(0, lastBoundary) : slice;
  return `${cut.trimEnd()}…`;
}
