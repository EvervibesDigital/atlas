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

// "[for hire]" is r/forhire's tag for a FREELANCER ADVERTISING THEMSELVES —
// the exact inverse of a job posting, but it hits every same keyword. Caught
// live on 2026-08-01 when a real scan surfaced "[FOR HIRE] Python Developer"
// alongside genuine [Hiring] posts. The brackets matter: they scope this to
// the tag convention, so an ordinary sentence using the words "for hire"
// isn't wrongly excluded.
const EXCLUDE_KEYWORDS = ["no ai", "humans only", "no bots", "no automated", "in-person only", "on-site only", "[for hire]"];

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

/** Word-boundary regex for a phrase, so "hire a" stops matching "hire api".
 * Boundaries are only asserted where the phrase actually begins/ends with a
 * word character, so punctuated entries like "job:" and "budget:" still
 * match. Naive String.includes here is what let Guru's "Hire API Developers"
 * landing page through as a real gig (128 of them, in production). */
function phraseRegex(phrase: string): RegExp {
  const esc = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lead = /\w/.test(phrase[0]!) ? "\\b" : "";
  const tail = /\w/.test(phrase[phrase.length - 1]!) ? "\\b" : "";
  return new RegExp(`${lead}${esc}${tail}`);
}
const HIRING_PHRASE_RES = HIRING_PHRASES.map(phraseRegex);

/** URL path shapes that mean "a page listing/selling many gigs" rather than
 * one specific posting — category pages, search results, marketing landing
 * pages, video pages. Note "/hire/" and "/hire-" both need the leading slash
 * so reddit.com/r/forhire/... (the best source in the query set) is not
 * caught by them. */
const CATEGORY_PATH_SIGNALS = [
  "/hire/", "/hire-", "/search", "/browse", "/categories",
  "/category/", "/tag/", "/skills/", "/services/", "/freelancers/", "/watch",
];

/**
 * True only when the URL looks like ONE specific job posting. The search
 * service already returns a url alongside title/snippet, but nothing used to
 * look at it — and it's the strongest available signal, because a page
 * *selling* hiring services uses the same words as a person *hiring*
 * ("Looking to hire a Scripter" is Guru's own marketing copy). Text can't
 * separate those; URL shape can.
 *
 * Deliberately biased toward rejecting: a missed gig costs nothing (the scan
 * runs hourly and supply is unlimited), while a junk gig costs Mat's
 * attention now and his reputation once auto-submit exists.
 */
export function isSpecificPosting(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return false; // a malformed URL from a search provider must never kill a scan
  }
  if (CATEGORY_PATH_SIGNALS.some((s) => path.includes(s))) return false;
  if (path.includes("/comments/")) return true; // Reddit permalink
  if (/\d{6,}/.test(path)) return true; // numeric posting id (craigslist, freelancer project ids)
  return false;
}

/** A job is AI-doable if it mentions a relevant keyword, actually reads like
 * someone hiring (not an article/thread ABOUT freelancing or its costs), and
 * doesn't explicitly rule out AI/bots. */
export function isAiDoable(title: string, snippet: string): boolean {
  const text = `${title} ${snippet}`.toLowerCase();
  if (EXCLUDE_KEYWORDS.some((k) => text.includes(k))) return false;
  if (DISCUSSION_SIGNALS.some((k) => text.includes(k))) return false;
  const hasAiKeyword = AI_DOABLE_KEYWORDS.some((k) => text.includes(k));
  const hasHiringSignal = HIRING_PHRASE_RES.some((re) => re.test(text)) || HIRING_PATTERNS.some((p) => p.test(text));
  return hasAiKeyword && hasHiringSignal;
}

/** The single filter every search path should use: the text has to read like
 * a real hiring post AND the URL has to be one specific posting. Combined
 * into one function on purpose — an optional `url?` parameter on isAiDoable
 * would be exactly the kind of thing a future call site silently forgets to
 * pass, which is how call:social sat missing from the orchestrator's
 * manifest for weeks without anyone noticing. */
export function isRealGigCandidate(title: string, snippet: string, url: string): boolean {
  return isAiDoable(title, snippet) && isSpecificPosting(url);
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
