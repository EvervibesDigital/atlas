import type * as cheerio from "cheerio";

/**
 * Pulls a usable contact email out of a page the scanner has ALREADY
 * downloaded.
 *
 * Why this exists: verified live 2026-08-01, all 128 leads in production had
 * a phone number and **zero** had an email — yet `leadscan.approve` sends
 * `email: lead.email ?? ""` to the n8n outreach workflow. So every one of
 * those 128 leads got marked `contacted` while there was no address to
 * contact. The scanner was already fetching and parsing each site's HTML, so
 * the address was sitting right there, unused.
 *
 * Deliberately conservative. A wrong address is worse than none: it either
 * bounces (hurting sender reputation) or reaches an unrelated third party.
 */

/** Addresses that are never a real business contact. */
const JUNK_PATTERNS = [
  /^(no-?reply|do-?not-?reply|postmaster|abuse|webmaster|hostmaster|mailer-daemon)@/i,
  /@(example|test|localhost|domain|yourdomain|email|sentry|wixpress|godaddy)\./i,
  /\.(png|jpe?g|gif|webp|svg|css|js)$/i,
  /^[0-9a-f]{16,}@/i, // tracking/hash addresses
];

/** Ranked best-first — a dedicated inbox beats a generic catch-all. */
const PREFERRED_PREFIXES = ["contact", "hello", "info", "office", "reception", "frontdesk", "admin", "team", "sales", "inquiries", "enquiries"];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function isJunk(email: string): boolean {
  return JUNK_PATTERNS.some((p) => p.test(email));
}

/** Rank: same-domain beats off-domain, preferred prefix beats anything else. */
function score(email: string, siteHost: string): number {
  const [localPart, host = ""] = email.toLowerCase().split("@");
  let s = 0;
  // Same registrable-ish domain — strongest signal it's really their inbox.
  const bare = siteHost.replace(/^www\./, "").toLowerCase();
  if (bare && (host === bare || host.endsWith(`.${bare}`))) s += 100;
  const idx = PREFERRED_PREFIXES.indexOf(localPart ?? "");
  if (idx >= 0) s += 50 - idx; // earlier prefix ranks higher
  // Free-mail is still usable for a small local business, just less ideal.
  if (/@(gmail|yahoo|hotmail|outlook|aol)\./.test(email.toLowerCase())) s += 5;
  return s;
}

/**
 * Returns the best contact email found on the page, or undefined.
 * `mailto:` links are trusted over addresses scraped from body text, since a
 * mailto is an explicit invitation to write to that address.
 */
export function extractContactEmail($: cheerio.CheerioAPI, html: string, pageUrl: string): string | undefined {
  let siteHost = "";
  try {
    siteHost = new URL(pageUrl).hostname;
  } catch {
    /* a malformed URL just means we lose the same-domain bonus */
  }

  const candidates: Array<{ email: string; bonus: number }> = [];

  // 1. mailto: links — explicit, so weighted above scraped text.
  $('a[href^="mailto:"]').each((_i, el) => {
    const href = $(el).attr("href") ?? "";
    const raw = href.slice("mailto:".length).split("?")[0]?.trim();
    if (raw) candidates.push({ email: raw, bonus: 200 });
  });

  // 2. Anything email-shaped in the raw HTML.
  for (const m of html.match(EMAIL_RE) ?? []) candidates.push({ email: m, bonus: 0 });

  const seen = new Set<string>();
  const ranked = candidates
    .map((c) => ({ ...c, email: c.email.trim().replace(/^mailto:/i, "") }))
    .filter((c) => {
      const key = c.email.toLowerCase();
      if (!key || seen.has(key) || isJunk(c.email)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.bonus + score(b.email, siteHost) - (a.bonus + score(a.email, siteHost)));

  return ranked[0]?.email;
}
