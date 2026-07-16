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

/** A job is AI-doable if it mentions a relevant keyword and doesn't explicitly rule out AI/bots. */
export function isAiDoable(title: string, snippet: string): boolean {
  const text = `${title} ${snippet}`.toLowerCase();
  if (EXCLUDE_KEYWORDS.some((k) => text.includes(k))) return false;
  return AI_DOABLE_KEYWORDS.some((k) => text.includes(k));
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
