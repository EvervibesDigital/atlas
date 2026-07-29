# KDP Upload Automation — Design

**Status:** Approved by Mat 2026-07-29 (design sections confirmed; spec self-reviewed, pending Mat's read of this file).

## Problem

Amazon KDP has no official publish API. Every book `@atlas/kdp` finds/generates/scores (`packages/kdp`) still requires Mat to manually open the KDP wizard, re-type metadata that already exists in Supabase, and re-upload files that `downloadZip` already produces. Mat's explicit ask (confirmed via AskUserQuestion earlier this session): automate the wizard with Playwright, but never let it click the final Publish button — stop there so he reviews and finishes it himself. This carries real account risk (no API, unlike Meta's Graph API used elsewhere in ATLAS), so the design keeps the same "simulate by default, real only when explicitly enabled" posture already used for every other real-world-acting capability in ATLAS.

## Scope

**In scope:** automating KDP's 3-step "Create new title" wizard (Details → Content → Rights & Pricing) for a single book, triggered manually per book, stopping immediately before the Publish click.

**Out of scope (explicitly deferred):** automatic/scheduled triggering (every "downloaded" book auto-uploads) — Mat chose manual-per-book; editing/re-uploading an already-published title; category-tree validation (see Known Limitation below); anything after the Publish click (sales tracking is a separate, already-flagged future sub-project).

## Architecture

A new op, `uploadToAmazon`, on the existing `packages/kdp` plugin (service `"kdp"`). Reuses `packages/browser`'s existing `BrowserStep`/`BrowserDriver` primitive — the declarative `goto | click | fill | upload | waitFor | press` step-list executor already built for the Actions department (`SimulatedDriver` for safe dry-runs, `PlaywrightDriver` for real) — rather than inventing a second automation paradigm for this one integration.

**Flow for `kdp.uploadToAmazon({ id })`:**
1. Call the existing `downloadZip` logic internally to get the book's real `interior.pdf`/`cover.pdf` (base64) — no new PDF/cover generation, this already works.
2. Write both files to a temp directory (`os.tmpdir()`-based, cleaned up after the run).
3. Build a `BrowserStep[]` for the book via a new pure function `buildUploadSteps(book: KdpBook, files: {interiorPath, coverPath}, policy: PricePolicy)` in a new file `packages/kdp/src/upload-steps.ts` — pure and unit-testable with no real browser involved.
4. Run the steps through `ctx`'s configured `BrowserDriver` (see Driver Selection below).
5. Return a structured summary (`{ ok, stepsRun, filled: {title, price, categoriesMatched, categoriesSkipped}, log }`) — Mat reads this before finishing the Publish click himself in the same real browser window (headed, not headless, since he needs to see it to finish it).

**Driver selection** mirrors the existing `ATLAS_REAL_ACTIONS` pattern (`packages/browser`, already wired into the Actions department): the kdp plugin takes an optional `driver` in its constructor options; if omitted, it builds one from `ATLAS_REAL_KDP_UPLOAD=true` (a *separate* env flag from `ATLAS_REAL_ACTIONS` — KDP touching a real paid publishing account is a materially different blast radius from the existing simulated-by-default actions, deserves its own explicit opt-in) → `createPlaywrightDriver({ headless: false, storageState: kdpSessionPath })`, else `SimulatedDriver`. Same shape as `AtlasOptions.actionsDriver` elsewhere in the codebase.

## Session handling

`createPlaywrightDriver` (in `packages/browser/src/index.ts`) gains an optional `storageState?: string` option — Playwright's built-in cookie/session persistence to a JSON file on disk. First-ever real run: the driver launches a real visible Chromium window at `kdp.amazon.com`, and if no valid session exists it stops immediately with a clear message ("Log into KDP in the window that just opened, then re-run") — it never fills a password field itself, matching the standing hard boundary on credentials. Once Mat logs in manually in that window, the driver saves `context.storageState()` to the configured path and every subsequent run reuses it silently. If a saved session has expired (detected by KDP redirecting to its own login page instead of the dashboard), the driver stops the same way rather than guessing or retrying blindly.

## Field-filling detail

`buildUploadSteps` fills, in wizard order:

- **Details (step 1):** title, subtitle (if present), series (skipped — not in `KdpBook`), description, up to 7 keywords, author = fixed `"Matthew Brittingham"` (no separate publisher field filled — left on KDP's own default), language = English, "This is not a public domain work."
- **Content (step 2):** manuscript upload = `interior.pdf`, cover upload = `cover.pdf` (both already finished, upload-ready files per the existing `downloadZip` README — no cover-creator flow needed), waits for KDP's own upload-progress indicator before proceeding (a real, necessary `waitFor` step — these uploads take real time and clicking "next" too early is a common cause of a broken wizard state).
- **Rights & Pricing (step 3):** territories = worldwide, royalty = KDP's own default for print (60% minus print cost — print books don't have the 35/70% ebook royalty-plan choice), list price = **$7.49 flat**, for every current product type (`journal`, `planner`, `workbook`, `coloring_book`) via a `PricePolicy = Record<string, number>` the plugin owns as a simple const (easy to change later without touching step-building logic), KDP Select = left unchecked (default).
- **Categories:** `KdpBook.categories` are AI-generated free-text BISAC guesses (e.g. `"Crafts & Hobbies > Journals"`), never validated against Amazon's real category tree. KDP's category picker is a search-then-select UI, not a text field. `buildUploadSteps` types each category string into the picker's search box and selects the first result if one appears (`waitFor` + `click` pair per category); if no result appears within the wait, that category is skipped and recorded in the returned summary's `categoriesSkipped` list rather than failing the whole run. This is the one deliberately best-effort part of the design — acceptable per Mat's explicit choice to build against best understanding now and fix against a real test run, rather than block on live selector reconnaissance first.
- **Stops here.** No step ever targets the Publish button. The last step in the generated list is always a `waitFor` on the Publish button's own selector, confirming the wizard reached the final page successfully — never a `click` on it.

## Error handling

Every external boundary (download, temp-file write, browser driver run) is a normal thrown error surfaced back through `ctx.provide`'s existing error path — no silent swallowing, matching every other op on this plugin. A failed/partial run leaves whatever the browser already filled visible in that same window (headed mode) so Mat can see exactly how far it got and finish manually rather than starting over blind. The temp directory is cleaned up in a `finally` regardless of outcome.

## Testing

- `packages/kdp/test/upload-steps.test.ts`: pure unit tests on `buildUploadSteps` — given a `KdpBook` + fake file paths + a price policy, asserts the exact `BrowserStep[]` shape (right selectors targeted, right values, category search-then-select pairing, no step ever clicks Publish). No real browser, no real KDP — this is where the actual field-mapping logic gets its real test coverage.
- `packages/kdp/test/kdp.test.ts`: extend with a `uploadToAmazon` op test using `SimulatedDriver` (already-established pattern from the Actions department's own tests) — proves the op wires `downloadZip` → temp files → step-building → driver correctly, asserts `ok:true` and a populated summary, without touching Playwright at all.
- `packages/browser`'s existing test file: add coverage for the new `storageState` option threading through to Playwright's launch config (mocked import, same pattern `createPlaywrightDriver`'s existing tests likely already use for the lazy `import("playwright")`).
- No test ever launches a real browser against real kdp.amazon.com — that first real run is Mat's own manual verification step, same as every other "needs one real click to confirm" item flagged elsewhere in ATLAS's history.

## Known limitations (stated plainly, not hidden)

1. Category selection is best-effort text-search-and-select against an unvalidated free-text field — may leave 0, 1, or 2 categories filled depending on how well the AI-generated guess matches Amazon's real category tree that day.
2. Built without live access to KDP's current wizard DOM — selectors are my best understanding of the current layout, not confirmed against the real live page. The first real run (Mat's own manual trigger, `ATLAS_REAL_KDP_UPLOAD=true` + real login) is expected to surface selector mismatches that get fixed as straightforward one-line patches in `upload-steps.ts`, not a redesign.
3. No 2FA/captcha handling of any kind — if KDP challenges the session mid-run, the run fails and Mat resolves it directly in the visible browser window.
