# CFO + Advisors Tabs — Design

**Status:** Approved by Mat 2026-07-31 ("do everything").

## Problem

Four ops are fully built, tested, and registered at boot, but none has ever been called from anywhere a human can reach: `cfo.forecast`, `cfo.roi`, `knowledge.playbook`, `archaeologist.dig`. Each only shows up as a label in the neural-map view (`html.ts:737`) — no route, no button, no tab. This is the same shape as the social-permission bug fixed earlier this session (a fully working feature with zero path to actually trigger it), one layer up: here the gap is a missing UI trigger, not a missing permission grant.

All four share one property that makes them cheap to wire together: each is a synchronous request-in/result-out op with no persisted job state and no polling — call it, get an answer, show it. (Media Factory's `produceVideo` does not share this property — see the separate design for that.)

## Scope

**In scope:** two new tabs (`CFO`, `Advisors`), four new routes, four new UI panels, each following the exact pattern already used for every other tab in `html.ts`/`server.ts` (nav button with `data-tab`, `<section id="tab-X" class="card hide">`, JS handler calling the existing client-side `api()` helper, server route wrapping `a.invoke(service, {op, ...})` in try/catch).

**Out of scope:** any change to the underlying ops themselves (`packages/cfo/src/finance.ts`, `packages/knowledge/src/plugin.ts`, `packages/advisors/src/index.ts`) — all four already work correctly. Not in scope: auto-wiring any of these into the hourly cycle — all four are "ask a question, get an answer" tools Mat reaches for on demand, not automation.

## Architecture

**Routes (`packages/server/src/server.ts`, next to the existing `/api/media-factory/*` block):**

- `POST /api/cfo/forecast` — body `{cashOnHand, monthlyRevenue?, monthlyExpenses}` → `a.invoke("cfo", {op:"forecast", inputs:{cashOnHand, monthlyRevenue, monthlyExpenses}})`. `cashOnHand` and `monthlyExpenses` required (400 if missing); `monthlyRevenue` optional (the op auto-fills it from `pullReal()` when omitted).
- `POST /api/cfo/roi` — body `{cost, expectedReturn}` (both required, 400 if missing) → `a.invoke("cfo", {op:"roi", cost, expectedReturn})`.
- `POST /api/knowledge/playbook` — body `{topic, limit?}` (`topic` required, 400 if missing) → `a.invoke("knowledge", {op:"playbook", topic, limit})`.
- `POST /api/archaeologist/dig` — body `{topic?}` (no required fields) → `a.invoke("archaeologist", {op:"dig", topic})`.

All four follow the exact try/catch/`send(res, 500, {error: (err as Error).message})` shape already used at `server.ts:1237-1256`.

**UI (`packages/server/src/html.ts`):**

- Add `"cfo"` and `"advisors"` to the tab-visibility array at `html.ts:683` and add two nav buttons next to the existing `data-tab="kdp"` / `data-tab="media-factory"` buttons (`html.ts:147-149`).
- `<section id="tab-cfo" class="card hide">`: a Forecast panel (three number inputs — cash on hand, monthly revenue [optional, placeholder "auto-filled if left blank"], monthly expenses — plus a "Run Forecast" button) rendering `netMonthly`, `runwayMonths`, `sixMonthProjection` (as a simple list), and `verdict` into a result `<div>`; and an ROI panel (two number inputs — cost, expected return — plus "Calculate ROI" button) rendering the returned percentage.
- `<section id="tab-advisors" class="card hide">`: a Knowledge panel (topic text input + optional limit number input, "Get Playbook" button) rendering the returned lessons as a list; and an Archaeologist panel (optional topic text input, "Dig Up Old Notes" button) rendering the 1-3 returned notes.
- Each panel's JS handler mirrors the existing `mfRunAutoCycle()` pattern (`html.ts:1329`): `async function X(){ try { const r = await api("/api/...", "POST", {...}); /* render r into the result div */ } catch(e) { /* show e.message */ } }`.

## Error handling

Missing required fields return 400 with a plain message before touching `a.invoke` (mirrors the existing `/api/media-factory/produce` validation at `server.ts:1240-1242`). Any op-level failure (e.g. `archaeologist.dig` failing to reach the Brain) is caught and returned as a 500 with `err.message`, displayed inline in the panel's result area — no silent failures, no alert() popups blocking the tab (existing Media Factory panels use `alert()` for some errors; these four use inline error text instead since a forecast/playbook result belongs in the tab, not a modal).

## Testing

- `packages/server/test/server.test.ts` (or wherever existing route tests for `/api/media-factory/*` live — follow that file's exact pattern): one request/response test per new route, covering the success path and the 400-on-missing-field path.
- `packages/server/test/page-script.test.ts`: already asserts the served client-side script parses as valid JS — the self-caught escaping bug from the Gig Finder work (single- vs double-backslash inside the outer template literal) means every new template-literal string in `html.ts` must be written matching the file's established double-backslash convention, and this test is what would catch it if not.

## Known limitations

1. `cfo.forecast`'s `sixMonthProjection` and `knowledge.playbook`'s lesson list are rendered as plain lists, not charts — matches the level of polish already used elsewhere in this UI (e.g. the Gig Finder tab), not a new design language.
2. These four ops remain purely on-demand. If usage shows a pattern worth automating (e.g. a weekly forecast), that would be new scope for a future design, not this one.
