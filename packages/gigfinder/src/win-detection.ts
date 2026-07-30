import type { Gig } from "./types";

/**
 * Win detection — reads a plain-text email and decides (a) does it look like
 * a "you got the job" notification, and (b) which pending gig is it about.
 * Both are pure, dependency-free heuristics (no brain call), same tradeoff
 * @atlas/social's scoreConfidence already accepts: a starting heuristic, not
 * a trained model — refine once real data exists.
 */

/** Same bar @atlas/social already uses for auto-sending a reply — a
 * classification at or above this is confident enough to act on unattended;
 * anything below defers to Mat via the Brief instead of guessing. */
export const WIN_CONFIDENCE_THRESHOLD = 90;

const WIN_PHRASES = [
  "you've been hired", "you have been hired", "job awarded", "you won the job", "you've won",
  "congratulations", "order confirmed", "accepted your proposal", "accepted your bid",
  "you got the job", "selected you", "hired you", "new order", "project awarded",
];

const NOT_WIN_PHRASES = [
  "unfortunately", "not selected", "other candidate", "went with someone else", "declined",
  "no longer available", "position filled", "we chose another",
];

/** 0-100 — most inbox email isn't a win notification, so this starts low and
 * only rises on a clear positive signal. A bare question reads as "needs
 * more info," not a done deal, so it pulls the score down slightly too. */
export function scoreWinConfidence(text: string): number {
  const lower = text.toLowerCase();
  let score = 20;
  if (WIN_PHRASES.some((p) => lower.includes(p))) score += 70;
  if (NOT_WIN_PHRASES.some((p) => lower.includes(p))) score -= 60;
  if (lower.includes("?")) score -= 10;
  return Math.max(0, Math.min(100, score));
}

/** Best-overlap match against a gig's title (words longer than 3 chars,
 * case-insensitive). Requires at least 40% of a gig's significant title
 * words to appear in the email text; returns the best-scoring gig among the
 * pending ones, or undefined if nothing clears that bar. */
export function matchGigForEmail(text: string, pendingGigs: Gig[]): Gig | undefined {
  const lower = text.toLowerCase();
  let best: Gig | undefined;
  let bestScore = 0;
  for (const gig of pendingGigs) {
    const titleWords = gig.title.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    if (titleWords.length === 0) continue;
    const matches = titleWords.filter((w) => lower.includes(w)).length;
    const score = matches / titleWords.length;
    if (score > bestScore && score >= 0.4) {
      bestScore = score;
      best = gig;
    }
  }
  return best;
}
