const NEGATIVE_WORDS = ["terrible", "worst", "broken", "refund", "scam", "hate", "awful", "bad", "angry", "disappointed"];

/**
 * Starting heuristic (0-100), not a trained model — refine once real data
 * exists. High-confidence = safe to auto-send: short, no question, no
 * negative-sentiment words. Anything else defers to a human — a wrong
 * auto-reply from a fake persona is a worse outcome than a slower one.
 */
export function scoreConfidence(text: string): number {
  let score = 95;
  if (text.includes("?")) score -= 40;
  if (text.length > 80) score -= 30;
  const lower = text.toLowerCase();
  if (NEGATIVE_WORDS.some((w) => lower.includes(w))) score -= 50;
  return Math.max(0, Math.min(100, score));
}
