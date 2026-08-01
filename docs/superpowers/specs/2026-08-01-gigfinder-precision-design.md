# Gig Finder Precision — Design

**Status:** Approved by Mat 2026-08-01 ("build it all").

## Problem

Confirmed against live production data: all 128 gigs sitting in `approved` status are not job postings. They are marketing landing pages, category pages, search-results pages, and one YouTube video. Of six sampled in depth, exactly one (a Reddit post in r/n8n from someone hiring automation freelancers) was a real lead — roughly 17% precision, and that is the optimistic read.

Two root causes, both verified empirically by running the real `isAiDoable` against the real titles that were accepted:

1. **The URL is fetched and then discarded.** `searchWeb()` receives `{title, url, snippet}` from the search service but passes only `title` and `snippet` to `isAiDoable`. The URL is the single strongest signal available for distinguishing one specific posting from a category page, and nothing looks at it.
2. **Marketing pages use identical hiring language, and a substring bug makes it worse.** Guru's landing page literally reads "Looking to hire a Scripter" — because selling that service is its purpose. Keyword matching cannot separate a page *selling hiring* from a person *hiring*. Compounding it, `HIRING_PHRASES` uses naive `String.includes`, so the phrase `"hire a"` matches `"hire api developers"` (verified: `"hire api developers online".includes("hire a") === true`).

A third contributing factor: of the four `WEB_SEARCH_QUERIES`, two are `site:reddit.com/r/forhire` (well-targeted, produce real leads) and two are generic open-web phrase searches — and SEO landing pages rank #1 for exactly those phrases. The generic queries are where the junk enters.

**Why this blocks the roadmap:** the stated goal is "find the gig, bid on it, win the bid." Step one is broken, so everything downstream rests on sand. Building the planned auto-submit on top of this would blast generic bids at YouTube videos and category pages under Mat's name — actively harmful, not merely useless. Auto-submit must wait until *find* is trustworthy.

## Governing principle

**Optimize for precision over recall.** A missed gig costs nothing — the supply is effectively unlimited and the scan runs hourly. A junk gig costs Mat's attention now, and once auto-submit exists, his reputation and platform standing. Three real gigs a week beats 128 fake ones. Every ambiguous call in this design resolves toward rejecting.

## Scope

**In scope:** a structural URL check, a word-boundary fix for hiring-phrase matching, a single combined entry point wired into both search paths, tightened search queries, and marking the existing 128 junk records as `rejected`.

**Out of scope:** the broken draft-bid text (one live bid reads, in full, `"Delivery Estimate):* Depending on your clients'"`). That is a separate defect in the brain-response path, and bids drafted against *real* postings may not exhibit it — re-check it once real gigs flow rather than guessing at a fix against junk inputs. Also out of scope: auto-submit (gig sub-projects 2-4), explicitly gated behind this work.

## Architecture

**`packages/gigfinder/src/matching.ts`** gains two things and fixes one.

*New — `isSpecificPosting(url: string): boolean`.* Pure, dependency-free, no network. Rejects any URL whose path carries a category/listing/marketing signal, then requires a positive specific-item signal:

```ts
const CATEGORY_PATH_SIGNALS = ["/hire/", "/hire-", "/search", "/browse", "/categories",
  "/category/", "/tag/", "/skills/", "/services/", "/freelancers/", "/watch"];

export function isSpecificPosting(url: string): boolean {
  let path: string;
  try { path = new URL(url).pathname.toLowerCase(); } catch { return false; }
  if (CATEGORY_PATH_SIGNALS.some((s) => path.includes(s))) return false;
  if (path.includes("/comments/")) return true;   // Reddit permalink
  if (/\d{6,}/.test(path)) return true;           // numeric posting id
  return false;
}
```

Verified by hand against every sampled URL: the Reddit permalink is accepted; `digiscorp.com/hire-api-developers`, `guru.com/m/hire/freelancers/api-developers`, `freelancer.com/hire/scripting`, `youtube.com/watch?v=…`, and `ziprecruiter.com/Jobs/Freelance-Automation` are all rejected. One subtle case matters and must be preserved by test: `reddit.com/r/**forhire**/comments/…` must NOT trip the `"/hire/"` signal (there is no slash immediately before `hire` in `forhire`), because r/forhire is the single best source in the query set.

*Fixed — word-boundary phrase matching.* Replace `String.includes` over `HIRING_PHRASES` with precompiled regexes that assert word boundaries, added only where the phrase actually begins/ends with a word character (so `"job:"` and `"budget:"` still work):

```ts
function phraseRegex(phrase: string): RegExp {
  const esc = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lead = /\w/.test(phrase[0]!) ? "\\b" : "";
  const tail = /\w/.test(phrase[phrase.length - 1]!) ? "\\b" : "";
  return new RegExp(`${lead}${esc}${tail}`);
}
const HIRING_PHRASE_RES = HIRING_PHRASES.map(phraseRegex);
```

*New — `isRealGigCandidate(title, snippet, url): boolean`.* A single combined entry point, `isAiDoable(title, snippet) && isSpecificPosting(url)`. Both call sites use this one function rather than remembering to call two. `isAiDoable` stays exported and unchanged in contract so its existing tests keep their meaning; this design deliberately avoids adding an optional `url?` parameter to it, because an optional parameter is exactly the kind of thing a future call site silently forgets to pass — the same silent-omission failure mode that let `call:social` sit unnoticed in the orchestrator manifest for weeks.

**`packages/gigfinder/src/plugin.ts`:** both filter call sites — `searchWeb()` (line ~66) and `searchScraped()` (line ~92) — switch from `isAiDoable(title, snippet)` to `isRealGigCandidate(title, snippet, url)`. The scraped path already carries `i.url`, so no plumbing changes are needed in either.

**Search queries.** Replace the two generic open-web phrase searches with targeted ones aimed at places real postings live, keeping the r/forhire pattern that already works. r/forhire's own convention tags hiring posts `[Hiring]`, which filters out freelancers advertising themselves:

```ts
const WEB_SEARCH_QUERIES = [
  "site:reddit.com/r/forhire [hiring] automation OR python OR scraper",
  "site:reddit.com/r/forhire [hiring] api OR bot OR integration OR script",
  "site:reddit.com/r/jobbit [hiring] automation OR developer",
  "site:reddit.com/r/n8n OR site:reddit.com/r/zapier looking for freelancer OR contractor automation",
];
```

The fourth targets the community that produced the one genuine lead in the sample.

**Backlog cleanup.** The 128 `approved` records are flipped to `rejected` by a one-off script run against the VPS's `data/gigs.json`, after taking a timestamped backup of that file. Nothing is deleted — the records remain, they simply stop counting as work waiting on Mat. Scoped strictly to `status === "approved"`; the 4 `new` and 1 `rejected` records are untouched.

## Error handling

`isSpecificPosting` returns `false` for anything `new URL()` cannot parse, rather than throwing — a malformed URL from a search provider must never take down a whole scan. This is consistent with the existing behavior in `searchWeb`, where one failing query is already caught and skipped rather than killing the search.

## Testing

- `packages/gigfinder/test/` (follow whichever file already covers `isAiDoable`): `isSpecificPosting` accepts the real Reddit permalink and rejects each of the five real junk URLs captured from production — these are the actual strings, not invented fixtures. Plus the r/forhire-must-not-trip-`/hire/` case, and a malformed-URL-returns-false case.
- Word-boundary regression: `isAiDoable("Hire API Developers Online", "<the real production snippet>")` must now return `false`, where it currently returns `true`. This is the substring bug pinned as a test.
- `isRealGigCandidate` returns `false` when the text passes but the URL is a category page, and `true` only when both hold.
- Live verification after deploy, matching how the ffmpeg and Reel-publish fixes were both confirmed this session: trigger a real scan against the real search provider and confirm what lands in `gigs.json` is either genuine postings or nothing at all — never junk. An empty result is a passing outcome here, not a failure.

## Known limitations

1. The numeric-ID rule rejects legitimate postings on boards using non-numeric identifiers — Upwork's `/jobs/~01abc…` and Indeed's `?jk=` query-string ids are both rejected. This is the precision-over-recall tradeoff taken deliberately; neither board appears in the current query set. Adding a board later means teaching `isSpecificPosting` that board's permalink shape, which is a one-line addition with a test.
2. The query set is now heavily Reddit-weighted, because that is where verified-real leads actually came from. Broadening to other platforms is a follow-up that requires extending the URL rules first, in that order — never the reverse.
3. This raises precision, not volume. Expect *fewer* gigs surfaced, possibly zero on some scans. That is the intended outcome, and the success measure is "is what appears real," not "how many appeared."
