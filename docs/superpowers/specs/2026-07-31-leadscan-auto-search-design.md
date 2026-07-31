# Lead Scan Auto-Search — Design

**Status:** Approved by Mat 2026-07-31 (design confirmed; spec self-reviewed, pending Mat's read of this file).

## Problem

`@atlas/leadscan` already does the two useful things Mat ported from the old compliance-bot repo: find real local businesses via Gemini's Google Maps grounding tool (`findLeads`), and run a real "vibe check" website scan (`scanWebsite`). Both are fully built and tested. Neither is ever called automatically — `findLeads` requires a specific `niche` + `city` per call, and nothing in the orchestrator's hourly cycle supplies one. The result: the Brief has working approve/reject buttons for leads (`fromLeadscan` in `@atlas/brief`, already built), but the funnel feeding it is empty — an outbox with no inbox. Confirmed live: 0 leads found in the last two weeks.

Mat's ask: search "all small businesses in any niche in any city, anyone we can reach." Since `findLeads` needs one concrete niche+city per call, "any/any" needs a real rotation, not a single hardcoded default.

**Constraint that shapes this design:** `findLeads` calls Gemini, and Gemini is currently hitting its daily quota cap in production (confirmed live on the VPS this session — real 429 "exceeded your current quota," not an auth issue). Adding automatic lead-finding directly competes with every other Gemini-dependent feature (video scripts, image prompts, gig-bid drafting) for the same limited daily budget. This design deliberately stays cheap: one Gemini call per hour, no more, regardless of how large the underlying niche/city list is.

## Scope

**In scope:** a fixed, built-in list of common small-business niches × US cities; a pure function that picks one combo per hour (no AI call spent deciding what to search — that would double the Gemini cost for no benefit); wiring that single pick into the orchestrator's existing hourly cycle via the already-built `leadscan.findLeads` op.

**Out of scope:** any change to `findLeads`, `scanWebsite`, the `LeadRegistry`, or the Brief's existing `fromLeadscan` integration — all of that already works and needs no changes. Not in scope: fixing the Gemini quota ceiling itself (tracked separately, Mat asked to revisit later) — this design just makes sure leadscan's one hourly call is a small, predictable addition to that budget, not a new source of runaway usage.

## Architecture

Two new pure exports from `packages/leadscan/src/rotation.ts`:

- `NICHE_CITY_COMBOS: Array<{niche: string; city: string}>` — the full cartesian product of a fixed `NICHES` list (15 common local-service categories likely to have outdated, non-compliant websites — the actual thing this business finds and fixes: plumbers, electricians, HVAC, dentists, chiropractors, small/solo law firms, real estate agents, restaurants, auto repair shops, hair salons/barbershops, landscaping, roofing, pest control, veterinary clinics, general contractors) and a fixed `CITIES` list (20 mid-size-to-major US metros spread across regions — Columbus, Austin, Denver, Charlotte, Nashville, Phoenix, Tampa, Sacramento, Indianapolis, Kansas City, Raleigh, Salt Lake City, Portland, Milwaukee, Louisville, Richmond, Boise, Tucson, Omaha, Providence — populous enough for real results, not so large they're dominated by national chains). 15 × 20 = 300 combos.
- `pickNicheCity(hourSeed: number, combos = NICHE_CITY_COMBOS): {niche: string; city: string}` — `combos[hourSeed % combos.length]`. Same shape as Media Factory's existing `deriveTopic(pillars, daySeed)` rotation, just at hourly instead of daily granularity, since leadscan runs every cycle (hourly) rather than once a day.

No persisted state needed: the orchestrator computes `hourSeed = Math.floor(Date.now() / (60 * 60 * 1000))` — a pure function of the current time — so which combo is "up" advances automatically every cycle and wraps around to the start after working through all 300 (roughly every 12-13 days at one search per hour), with no counter to store, load, or get out of sync.

**Wiring:** one new line in `packages/orchestrator/src/plugin.ts`'s existing cycle array, next to the other `optional(...)` steps: compute the current combo via `pickNicheCity`, then `optional(ctx.call, "leadscan", {op: "findLeads", niche, city}, health)`. No new op on the leadscan plugin — `findLeads` already does everything needed (finds businesses, scans each one's site immediately, queues them as `"new"` leads, which the Brief already surfaces). Same failure-isolation every other cycle step already has: a bad Gemini response, a scan failure, or a missing `GEMINI_API_KEY` shows up as a recorded (non-fatal) failure in that cycle's health report, exactly like every other not-yet-configured step already behaves — nothing new to build there.

## Error handling

Nothing new needed. `findLeads` already throws a clear "no GEMINI_API_KEY set" error if unconfigured, and already returns `[]` gracefully if Gemini's response doesn't parse as valid JSON — both cases the `optional()` wrapper already handles the same way every other cycle step's failures are handled.

## Testing

- `packages/leadscan/test/rotation.test.ts`: pure unit tests on `pickNicheCity` — cycles through the full list in order, wraps around correctly after the last combo, is a pure function of its seed (same seed always returns the same combo). No network, no Gemini, no registry involved.
- `packages/orchestrator/test/orchestrator.test.ts` or `packages/app/test/cycle.test.ts` (whichever already has precedent for asserting a specific `optional(...)` call — if neither does, per the KDP/gigfinder plans' own established finding this session, no dedicated wiring test is added, consistent with how `gigfinder.search`/`social.pollInbox`'s own wiring has none either): confirm the repo's full test suite still passes with the new line added.

## Known limitations (stated plainly)

1. The niche/city list is a fixed, built-in set chosen for likely lead quality (small independent businesses, geographically spread), not something Mat curated — easy to edit later (add/remove entries in `rotation.ts`) if some combinations turn out to be low-value or if Mat wants to focus on specific markets instead.
2. At one search per hour, a full pass through all 300 combos takes ~12-13 days. This is a deliberate tradeoff against the current Gemini quota ceiling, not a technical limit — if the quota issue gets resolved later (tracked separately), the search-per-cycle count can be raised without redesigning anything here.
3. `findLeads` returns up to 5 businesses per call (Gemini's own behavior, not configurable in this design) — so total lead volume is bounded by both the hourly cadence and that per-call cap.
