import { createHash } from "node:crypto";

/**
 * Matching + scoring for candidate gigs. Kept dependency-free and pure so it's
 * trivially testable — no network, no brain calls.
 */

const AI_DOABLE_KEYWORDS = [
  "automation", "automate", "scraping", "scrape", "api", "data processing", "data entry",
  "content writing", "copywriting", "coding", "code", "developer", "integration", "bot",
  "chatbot", "ai ", " ai", "web scraping", "testing", "script", "zapier", "make.com",
  "spreadsheet", "excel", "workflow", "no-code", "n8n",
];

const EXCLUDE_KEYWORDS = ["no ai", "humans only", "no bots", "no automated", "in-person only", "on-site only"];

// A page can mention "automation" and "API" and still not be a job posting —
// a pricing article or a "how much should I charge" forum thread hits the
// same keywords. Require an actual hiring-intent phrase too, and reject the
// common "this is content ABOUT freelancing" phrasings outright.
const HIRING_PHRASES = [
  "hiring", "looking for someone", "looking for a", "seeking a", "we are hiring",
  "job:", "gig:", "budget:", "apply now", "send proposal", "dm me", "message me",
  "please apply", "open to work", "posting a job", "freelance job", "contract position",
  "project for hire", "hire a", "hire someone",
];
// "need a/an/someone to <do X>" and "looking to hire" cover the single most
// common real-posting opener without hardcoding every possible profession.
const HIRING_PATTERNS = [/\bneed(?:s|ed)? (?:a|an|someone|somebody)\b/, /\blooking to hire\b/];

const DISCUSSION_SIGNALS = [
  "how much does", "how much should", "how much do", "what is the average cost",
  "pricing guide", "cost of hiring", "how to price", "average rate for", "guide to",
  "tips for freelancers", "best practices", "how to become a", "vs freelance",
  "pros and cons", "ultimate guide", "what freelancers charge",
];

/** A job is AI-doable if it mentions a relevant keyword, actually reads like
 * someone hiring (not an article/thread ABOUT freelancing or its costs), and
 * doesn't explicitly rule out AI/bots. */
export function isAiDoable(title: string, snippet: string): boolean {
  const text = `${title} ${snippet}`.toLowerCase();
  if (EXCLUDE_KEYWORDS.some((k) => text.includes(k))) return false;
  if (DISCUSSION_SIGNALS.some((k) => text.includes(k))) return false;
  const hasAiKeyword = AI_DOABLE_KEYWORDS.some((k) => text.includes(k));
  const hasHiringSignal = HIRING_PHRASES.some((k) => text.includes(k)) || HIRING_PATTERNS.some((p) => p.test(text));
  return hasAiKeyword && hasHiringSignal;
}

/** Best-effort dollar amount extraction from free text (e.g. "$50", "$50-100", "50 USD"). */
export function extractBudget(text: string): number | undefined {
  const m = text.match(/\$\s?(\d{1,6})(?:[.,]\d{2})?/);
  if (m && m[1]) return Number(m[1]);
  const m2 = text.match(/(\d{1,6})\s?(?:usd|dollars)/i);
  if (m2 && m2[1]) return Number(m2[1]);
  return undefined;
}

/** Stable fingerprint for dedup — same job posted across multiple sources/platforms collapses to one entry. */
export function dedupeKey(title: string, snippet: string): string {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("md5").update(`${norm(title)}|${norm(snippet).slice(0, 120)}`).digest("hex");
}

/** 0..1 score — budget presence/size and title specificity both help. Rough, not scientific. */
export function scoreCandidate(title: string, snippet: string, budget?: number): number {
  let score = 0.4;
  if (budget) score += Math.min(0.3, budget / 500);
  if (title.length > 15) score += 0.1;
  if (/\b(urgent|asap|today|immediately)\b/i.test(`${title} ${snippet}`)) score += 0.1;
  return Math.min(1, score);
}
