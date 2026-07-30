# Gig Finder Win Detection — Design

**Status:** Approved by Mat 2026-07-30 (design sections confirmed; spec self-reviewed, pending Mat's read of this file).

**Context:** Sub-project 1 of 4 toward Mat's full-autonomy Gig Finder goal ("find the gig, bid on it, win the bid, do the work, I approve, and it submits — do as little as possible"). Confirmed decomposition and order: (1) win detection — this spec, (2) work-execution engine + finished-work approval, (3) auto-submit on web/Reddit-sourced leads, (4) auto-submit on Fiverr/Guru/Craigslist via a real browser (KDP-style, stop-and-notify on any CAPTCHA/bot-detection challenge rather than attempting to solve it). Each sub-project gets its own spec → plan → build cycle.

## Problem

`@atlas/gigfinder` already finds AI-doable gigs, drafts a pitch, and tracks status through `"submitted"` (Mat pastes the draft in and clicks submit himself, then tells ATLAS `markSubmitted`). Nothing after that point is automated: Mat has to notice a client accepted the bid himself, on whatever platform sent the notification, before any actual work can start. That's the opposite of "do as little as possible" — it's the one step that currently requires Mat to be watching for something.

`@atlas/email` already gives ATLAS a real, working inbox reader (IMAP, `email.check`) built for a different purpose (reading confirmation links for approval-gated signups). This sub-project reuses it to close the loop: detect a gig win from the inbox automatically, without adding any new account access.

## Scope

**In scope:** a new `checkWins` op on `@atlas/gigfinder` that reads recent email, matches it against pending (`"submitted"`) gigs, and either confidently marks a gig `"won"` or queues an ambiguous reply for Mat to review in the Brief. Wiring `checkWins` into the existing hourly orchestrator cycle, next to the existing `gigfinder.search` step.

**Out of scope (deferred to later sub-projects):** anything that happens *after* a gig is marked `"won"` — sub-project 1 only detects the win and stops. No work gets started, no deliverable gets produced. Auto-submitting bids (sub-projects 3–4) is untouched; Mat still submits every bid himself for now, exactly as today.

## Architecture

A new pure module, `packages/gigfinder/src/win-detection.ts`, exports two functions with no I/O:
- `scoreWinConfidence(text: string): number` — a 0–100 heuristic, same style and same file-shape as `@atlas/social`'s existing `scoreConfidence` (positive win-phrases like "you've been hired," "job awarded," "congratulations," "order confirmed," "accepted your proposal" raise the score; negative/uncertain signals like "unfortunately," "not selected," "other candidate," or a bare question mark lower it).
- `matchGigForEmail(text: string, pendingGigs: Gig[]): Gig | undefined` — pure keyword/title-overlap match against the list of currently-`"submitted"` gigs; returns the best match or `undefined` if nothing overlaps meaningfully.

`checkWins` (in `packages/gigfinder/src/plugin.ts`) is the only impure piece:
1. `ctx.call("email", { op: "check", limit: 20 })` — the 20 most recent inbox messages (no new storage needed for dedup — see Data Model below for why).
2. `registry.list("submitted")` — the gigs currently awaiting a reply.
3. For each email, run it through `matchGigForEmail`; skip anything that doesn't match a pending gig.
4. For a match, run `scoreWinConfidence`. At or above the same **90** bar `@atlas/social` already uses for auto-sending a reply: update the gig to `"won"` and emit `gigfinder.won`. Below 90: update the gig to `"responded"` with the email's text attached (`notes`), which surfaces it in the Brief instead of guessing.
5. Return `{ checked, won, flagged }` — a small summary, same shape convention as `gigfinder.search`'s return value.

`checkWins` gets wired into `packages/orchestrator/src/plugin.ts`'s existing cycle, immediately after the existing `optional<unknown>(ctx.call, "gigfinder", { op: "search", sources: ["web"] }, health)` line — same `optional(...)` wrapper, same "one step failing doesn't fail the cycle" guarantee every other step already has.

## Data model

`GigStatus` (in `packages/gigfinder/src/types.ts`) gains one new value: `"won"`, alongside the existing `new | approved | rejected | submitted | responded | completed | paid`. `"responded"` (already an existing status, currently unused by any code path) becomes the "client replied, not confidently a win, needs your eyes" state — no new status needed for that. The existing `Gig.notes?: string` field (already present, currently unused) holds the email snippet when a gig is flagged `"responded"`, so the Brief item can show *why* it's there.

**No new persisted "seen email ids" store.** Dedup happens for free through the status transition: `checkWins` only ever matches against gigs still in `"submitted"` status, so once a gig moves to `"won"` or `"responded"` it naturally drops out of consideration on the next run — nothing to track separately, and no change to the registry's on-disk JSON shape (still a plain `Gig[]`, so Mat's existing `data/gigs.json` keeps working with zero migration). A generic, ultra-vague reply matching more than one still-pending gig is a real but low-stakes edge case for a first version — the confidence threshold and the human review step for anything below it are the actual safety net, not perfect matching.

## Brief integration

`packages/brief/src/plugin.ts`'s existing `fromGigFinder` currently only surfaces `"new"` gigs (bulk-tier, "approve to draft a pitch"). It gains a second query for `"responded"` gigs, surfaced as **`"ask"`-tier** items (an individual judgment call, same bar as social's "reply needed" items) — title `Possible win: <gig title>`, detail showing the attached email snippet. Approving means "yes, ATLAS read this right, mark it won"; rejecting means "no, this isn't a win, drop it."

`actOne`'s existing `gigfinder` branch in `brief/plugin.ts` currently always calls the `approve`/`reject` ops (correct for `"new"` gigs, wrong for `"responded"` ones). It gains a status lookup first — via a new, small `{ op: "get"; id: string }` command on `GigFinderCommand` (wraps the registry's existing internal `get(id)`, which nothing external could call before) — then routes: `"new"` → existing `approve`/`reject`; `"responded"` → two new ops, `confirmWin` (sets `"won"`, emits `gigfinder.won`) and `dismissWin` (sets `"rejected"` — reusing the existing status rather than adding a new one, since "not actually a win" and "not worth pursuing" land in the same bucket for tracking purposes). Anything else throws a clear "already handled" error, the same way `surplus`'s branch already does for a lead that's moved on.

## Error handling

One email failing to parse/classify doesn't stop the batch — same `try { } catch { /* one query failing shouldn't kill the whole search */ }` convention `searchWeb` already uses a few lines above where `checkWins` will live. If `@atlas/email` isn't configured yet (no `EMAIL_USER`/`EMAIL_PASS`), `email.check` throws its own clear "Email not configured" error; `checkWins` lets that propagate up through the `optional(...)` wrapper in the orchestrator cycle, which already treats any thrown error as "skip this step, keep going" — so gig-win checking silently no-ops until Mat sets up email, exactly like KDP's cycle steps silently no-op without `KDP_CRON_SECRET`.

## Testing

- `packages/gigfinder/test/win-detection.test.ts`: pure unit tests on `scoreWinConfidence` (clear win phrase scores high, a rejection/question scores low) and `matchGigForEmail` (matches the right gig by title/keyword overlap, returns `undefined` for an email with no plausible match) — no email, no brain, no registry involved.
- `packages/gigfinder/test/gigfinder.test.ts`: extend with a `checkWins` op test using a fake `email` service returning a canned inbox and a registry seeded with pending gigs — asserts a high-confidence match lands as `"won"`, a low-confidence match lands as `"responded"` with `notes` set, and a non-matching email is ignored.
- `packages/brief/test/brief.test.ts`: extend with a case confirming `"responded"` gigs surface as `"ask"`-tier Brief items, and that approving/rejecting one routes to `confirmWin`/`dismissWin` rather than `approve`/`reject`.
- `packages/orchestrator/test/*`: confirm `checkWins` is called once per cycle alongside the existing `gigfinder.search` call, following whatever pattern that test file already uses to assert on `pollInbox`/`search` being invoked.

## Known limitations (stated plainly)

1. The win/no-win classification is a keyword heuristic, not an LLM call — same tradeoff `@atlas/social`'s existing confidence scoring already accepts ("starting heuristic, not a trained model — refine once real data exists"). It will misjudge some real emails; the 90-point bar and the Brief fallback are the safety net, not perfection.
2. Matching an email to *which* pending gig it's about is also heuristic (keyword/title overlap) — a generic-sounding reply on a day with several similarly-worded pending bids could match the wrong gig. Low-stakes: worst case it's a `"responded"` item Mat reviews and rejects, or (rarer) a wrong gig getting marked `"won"` that sub-project 2 would then need Mat to notice is wrong when he reviews the finished work — not silent, not irreversible.
3. `checkWins` reads the 20 most recent inbox messages every cycle regardless of whether ATLAS's own outbound gig pitches are even a fraction of that inbox's real traffic — for a busy personal inbox, a real win notification could in theory scroll past 20 messages between cycles. Acceptable for a first version; raising the limit or adding a real cursor/dedup-by-message-id is a one-line follow-up if it turns out to matter in practice.
