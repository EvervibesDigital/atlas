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

/**
 * Salaried employment, not a gig.
 *
 * Mat wants short jobs ATLAS can finish in days. A full-time engineering role
 * is a months-long commitment with interviews attached — applying wastes his
 * time and the client's. Measured against the real queue on 2026-08-02, which
 * held six of these, including "[Hiring] Senior Full-Stack Engineers |
 * Next.js + Python/FastAPI | Remote" and "[Hiring] Go/Golang job: Senior
 * Software Engineer".
 */
const EMPLOYMENT_SIGNALS = [
  "full-time", "full time", "fulltime", "part-time employee", "w2", "401k",
  "benefits package", "health insurance", "paid time off", "pto",
  "salary", "salaried", "annual compensation", "equity package",
  "join our team", "join the team", "we're building a team",
];

/**
 * Seniority titles that mean "career hire", not "small paid task".
 * Kept separate from EMPLOYMENT_SIGNALS because a real gig CAN say "senior
 * developer wanted for a 2-day script" — so seniority alone doesn't reject;
 * it only counts when paired with an employment signal or a job-title shape.
 */
// One optional qualifier is allowed between the seniority word and the role.
// The real posting was "Senior Full-Stack Engineers" — requiring the two
// words to be adjacent missed it completely.
const CAREER_TITLE_RE = /\b(senior|staff|principal|lead)\s+(?:[\w-]+\s+)?(engineer|developer|architect)s?\b/i;

/**
 * Reddit post ids are base36 and monotonically increasing. Ids of 7 chars
 * beginning with "1" are 2023-onward; 6-char ids are 2022 and earlier.
 * Verified against the live queue: 55 of 58 were 7-char, and the 6-char ones
 * were a 2020 State Farm posting and a 2022 script request — both long dead.
 *
 * This is a coarse floor, not a freshness check. It cannot tell yesterday from
 * six months ago, which is why it only removes the obviously-ancient.
 */
export function isAncientRedditPost(url: string): boolean {
  const m = /\/comments\/([a-z0-9]+)/i.exec(url ?? "");
  if (!m) return false;
  const id = m[1]!;
  if (id.length >= 7) return false;
  return true;
}

/** Titles that are the site's own boilerplate, not the posting's. */
export function isJunkTitle(title: string): boolean {
  const t = (title ?? "").trim().toLowerCase();
  if (!t) return true;
  return [
    "reddit - the heart of the internet",
    "reddit - dive into anything",
    "just a moment...",
    "access denied",
  ].some((j) => t.includes(j));
}

/**
 * Whole-phrase containment, so a short signal can't hide inside a longer word.
 * Written with explicit boundary checks rather than a built regex because the
 * signals contain `-` and `+`, which are regex metacharacters — escaping them
 * inline is how this got broken twice.
 */
export function wordPresent(haystack: string, needle: string): boolean {
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  let from = 0;
  for (;;) {
    const i = h.indexOf(n, from);
    if (i < 0) return false;
    const before = i === 0 ? "" : h[i - 1]!;
    const after = i + n.length >= h.length ? "" : h[i + n.length]!;
    const isWordChar = (c: string) => c !== "" && /[a-z0-9]/.test(c);
    if (!isWordChar(before) && !isWordChar(after)) return true;
    from = i + 1;
  }
}

/** Salaried role rather than a short paid task. */
export function isEmploymentPosting(title: string, snippet: string): boolean {
  // TITLE ONLY, deliberately — and `snippet` is kept in the signature so every
  // existing call site stays correct.
  //
  // Search snippets here are Reddit LISTING-PAGE text: several unrelated
  // postings mashed into one string. Measured on the live queue, that made
  // "[Hiring] $15/hr - Simple OpenAI API Integration (fast 2-hour task)" match
  // "full-time" from a *different* job further down the same page. A false
  // positive silently deletes a gig Mat wanted; a false negative just means he
  // skips one card. The title belongs to the post itself, so it is the only
  // trustworthy field.
  const text = (title ?? "").toLowerCase();

  // Word-boundary matching, not substring: "pto" was matching "crypto" and
  // flagging crypto-bot gigs as salaried employment.
  if (EMPLOYMENT_SIGNALS.some((k) => wordPresent(text, k))) return true;

  // An annual-scale figure is a salary, not a project budget. Gig budgets in
  // this queue run $15-$500; a five-figure number is a yearly package.
  const money = /\$?\s?(\d[\d,]{4,})/.exec(text.replace(/,/g, ""));
  if (money && Number(money[1]) >= 30000) return true;

  // A career-grade title with no budget attached reads as a staff role.
  if (CAREER_TITLE_RE.test(text) && !/\$\s?\d/.test(text)) return true;
  return false;
}

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
  if (isJunkTitle(title)) return false;
  if (isEmploymentPosting(title, snippet)) return false;
  if (isAncientRedditPost(url)) return false;
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
