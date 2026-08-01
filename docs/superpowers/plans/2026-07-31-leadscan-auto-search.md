# Lead Scan Auto-Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `@atlas/leadscan` a real inbox — wire its already-built `findLeads` op into the orchestrator's hourly cycle, one niche+city search per hour from a fixed 300-combo rotation, so compliance leads actually start showing up in the Brief instead of the funnel sitting empty.

**Architecture:** A new pure module (`NICHE_CITY_COMBOS` + `pickNicheCity`) picks one niche+city combo per hour as a function of the current time — no persisted counter, no extra AI call spent deciding what to search. The orchestrator computes the hour's pick and calls the existing `leadscan.findLeads` op with it, wrapped in the same `optional(...)` failure-isolation every other cycle step already has.

**Tech Stack:** TypeScript, Vitest. No new dependencies — reuses `@atlas/leadscan`'s existing `findLeads`/registry/Brief integration untouched.

---

### Task 1: Pure niche/city rotation

**Files:**
- Create: `packages/leadscan/src/rotation.ts`
- Modify: `packages/leadscan/src/index.ts`
- Test: `packages/leadscan/test/rotation.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/leadscan/test/rotation.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { NICHE_CITY_COMBOS, pickNicheCity } from "../src/rotation";

describe("NICHE_CITY_COMBOS", () => {
  it("is the full cartesian product of 15 niches and 20 cities", () => {
    expect(NICHE_CITY_COMBOS.length).toBe(300);
  });

  it("has no duplicate niche+city pairs", () => {
    const seen = new Set(NICHE_CITY_COMBOS.map((c) => `${c.niche}|${c.city}`));
    expect(seen.size).toBe(NICHE_CITY_COMBOS.length);
  });
});

describe("pickNicheCity", () => {
  const combos = [
    { niche: "plumbers", city: "Columbus, OH" },
    { niche: "dentists", city: "Austin, TX" },
    { niche: "restaurants", city: "Denver, CO" },
  ];

  it("is a pure function of its seed — same seed always returns the same combo", () => {
    expect(pickNicheCity(5, combos)).toEqual(pickNicheCity(5, combos));
  });

  it("cycles through the list in order as the seed increments", () => {
    expect(pickNicheCity(0, combos)).toEqual(combos[0]);
    expect(pickNicheCity(1, combos)).toEqual(combos[1]);
    expect(pickNicheCity(2, combos)).toEqual(combos[2]);
  });

  it("wraps around to the start after the last combo", () => {
    expect(pickNicheCity(3, combos)).toEqual(combos[0]);
    expect(pickNicheCity(4, combos)).toEqual(combos[1]);
  });

  it("defaults to NICHE_CITY_COMBOS when no list is passed", () => {
    const picked = pickNicheCity(0);
    expect(picked).toEqual(NICHE_CITY_COMBOS[0]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/leadscan/test/rotation.test.ts`
Expected: FAIL — cannot find module `../src/rotation`.

- [ ] **Step 3: Implement `rotation.ts`**

Create `packages/leadscan/src/rotation.ts`:

```typescript
/**
 * Fixed, built-in niche/city rotation for auto-search — "any niche, any
 * city" needs a real list to pick from, since findLeads takes one concrete
 * niche+city per call. Niches are common local-service businesses likely to
 * have outdated, non-compliant websites (the actual thing this business
 * finds and fixes); cities are mid-size-to-major US metros spread across
 * regions — populous enough for real search results, not so large they're
 * dominated by national chains.
 */
export const NICHES = [
  "plumbers",
  "electricians",
  "HVAC contractors",
  "dentists",
  "chiropractors",
  "small law firms",
  "real estate agents",
  "restaurants",
  "auto repair shops",
  "hair salons",
  "landscaping companies",
  "roofing contractors",
  "pest control companies",
  "veterinary clinics",
  "general contractors",
];

export const CITIES = [
  "Columbus, OH",
  "Austin, TX",
  "Denver, CO",
  "Charlotte, NC",
  "Nashville, TN",
  "Phoenix, AZ",
  "Tampa, FL",
  "Sacramento, CA",
  "Indianapolis, IN",
  "Kansas City, MO",
  "Raleigh, NC",
  "Salt Lake City, UT",
  "Portland, OR",
  "Milwaukee, WI",
  "Louisville, KY",
  "Richmond, VA",
  "Boise, ID",
  "Tucson, AZ",
  "Omaha, NE",
  "Providence, RI",
];

export interface NicheCityCombo {
  niche: string;
  city: string;
}

/** Full cartesian product — every niche gets tried in every city. 15 × 20 = 300. */
export const NICHE_CITY_COMBOS: NicheCityCombo[] = NICHES.flatMap((niche) => CITIES.map((city) => ({ niche, city })));

/** Picks one combo per hour as a pure function of the current time — no
 * persisted counter needed, so nothing to get out of sync. Same rotation
 * pattern as @atlas/media-factory's deriveTopic(), just at hourly instead of
 * daily granularity since leadscan runs every cycle, not once a day. */
export function pickNicheCity(hourSeed: number, combos: NicheCityCombo[] = NICHE_CITY_COMBOS): NicheCityCombo {
  return combos[((hourSeed % combos.length) + combos.length) % combos.length]!;
}
```

- [ ] **Step 4: Run the tests again to verify they pass**

Run: `pnpm exec vitest run packages/leadscan/test/rotation.test.ts`
Expected: All 7 tests pass.

- [ ] **Step 5: Export the new module from the package index**

In `packages/leadscan/src/index.ts`, add a line so the new module is part of the package's public surface — change:

```typescript
export { createLeadScanPlugin } from "./plugin";
export { scanWebsite } from "./scanner";
export { findLeads, type FoundLead } from "./leadfinder";
export { LeadRegistry } from "./registry";
export type { LeadScanCommand, Lead, LeadStatus, ScanResult, ScanIssue } from "./types";
```

to:

```typescript
export { createLeadScanPlugin } from "./plugin";
export { scanWebsite } from "./scanner";
export { findLeads, type FoundLead } from "./leadfinder";
export { LeadRegistry } from "./registry";
export type { LeadScanCommand, Lead, LeadStatus, ScanResult, ScanIssue } from "./types";
export { NICHES, CITIES, NICHE_CITY_COMBOS, pickNicheCity, type NicheCityCombo } from "./rotation";
```

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add packages/leadscan/src/rotation.ts packages/leadscan/src/index.ts packages/leadscan/test/rotation.test.ts
git commit -m "feat(leadscan): add pure niche/city rotation for auto-search

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Wire into the hourly cycle

**Files:**
- Modify: `packages/orchestrator/package.json`
- Modify: `packages/orchestrator/src/plugin.ts`

- [ ] **Step 1: Read the current files to confirm exact content**

Read `packages/orchestrator/package.json` and `packages/orchestrator/src/plugin.ts` yourself before editing — this plan was written against their current state, but confirm nothing has drifted (in particular, confirm the `Promise.all([...])` destructuring array around line 152 and the `intel` object around line 207 still look the way this plan describes).

- [ ] **Step 2: Add the `@atlas/leadscan` dependency**

In `packages/orchestrator/package.json`, change:

```json
"dependencies": { "@atlas/core": "workspace:*", "@atlas/kdp": "workspace:*" },
```

to:

```json
"dependencies": { "@atlas/core": "workspace:*", "@atlas/kdp": "workspace:*", "@atlas/leadscan": "workspace:*" },
```

Run: `pnpm install`
Expected: Lockfile updates, no errors.

- [ ] **Step 3: Import `pickNicheCity`**

In `packages/orchestrator/src/plugin.ts`, change:

```typescript
import { shouldPauseGeneration, type KdpBook } from "@atlas/kdp";
```

to:

```typescript
import { shouldPauseGeneration, type KdpBook } from "@atlas/kdp";
import { pickNicheCity } from "@atlas/leadscan";
```

- [ ] **Step 4: Compute the hour's pick and add it to the cycle**

Find this line (it should still be there, unchanged):

```typescript
        const [curiosity, repoScout, businessScout, freeTools, github, tidy, newsletters, gigs, gigsCheckWins, kdpScan, kdpGenerate, mediaFactory, socialInbox, healResult] = await Promise.all([
```

Replace it with (adds `leadscanFound` to the destructured list, in a new position right after `gigsCheckWins` and before `kdpScan`):

```typescript
        const nicheCity = pickNicheCity(Math.floor(Date.now() / (60 * 60 * 1000)));
        const [curiosity, repoScout, businessScout, freeTools, github, tidy, newsletters, gigs, gigsCheckWins, leadscanFound, kdpScan, kdpGenerate, mediaFactory, socialInbox, healResult] = await Promise.all([
```

Then find the existing `gigsCheckWins` step (still inside that same `Promise.all([...])` array):

```typescript
          // Gig Finder win detection — reads recent email for a confident
          // "you got the job" match against pending bids and marks it won;
          // anything less certain queues in the Brief instead of guessing.
          // No-ops gracefully if EMAIL_USER/EMAIL_PASS aren't configured yet.
          optional<unknown>(ctx.call, "gigfinder", { op: "checkWins" }, health),
```

Add immediately after it (still inside the array, before the `kdp scan` step):

```typescript
          // Lead Scan — one niche+city search per hour from a fixed 300-combo
          // rotation ("any niche, any city, anyone we can reach"), a pure
          // function of the current time so nothing needs to be persisted.
          // Deliberately just ONE search per cycle: findLeads calls Gemini,
          // and Gemini is already at its daily quota ceiling — this keeps
          // leadscan's addition to that shared budget small and predictable
          // regardless of how big the underlying rotation list is. No-ops
          // gracefully if GEMINI_API_KEY isn't configured yet.
          optional<unknown>(ctx.call, "leadscan", { op: "findLeads", niche: nicheCity.niche, city: nicheCity.city }, health),
```

- [ ] **Step 5: Add `leadscanFound` to the `intel` report object**

Find:

```typescript
        const intel = {
          curiosity: curiosity ?? null,
          repoScout: repoScout ?? null,
          businessScout: businessScout ?? null,
          freeTools: freeTools ?? null,
          github: github ?? null,
          tidy: tidy ?? null,
          newsletters: newsletters ?? null,
          gigs: gigs ?? null,
          gigsCheckWins: gigsCheckWins ?? null,
          kdpScan: kdpScan ?? null,
          kdpGenerate: kdpGenerate ?? null,
          mediaFactory: mediaFactory ?? null,
          socialInbox: socialInbox ?? null,
        };
```

Replace it with (adds `leadscanFound` right after `gigsCheckWins`, matching the same position it has in the destructured array above):

```typescript
        const intel = {
          curiosity: curiosity ?? null,
          repoScout: repoScout ?? null,
          businessScout: businessScout ?? null,
          freeTools: freeTools ?? null,
          github: github ?? null,
          tidy: tidy ?? null,
          newsletters: newsletters ?? null,
          gigs: gigs ?? null,
          gigsCheckWins: gigsCheckWins ?? null,
          leadscanFound: leadscanFound ?? null,
          kdpScan: kdpScan ?? null,
          kdpGenerate: kdpGenerate ?? null,
          mediaFactory: mediaFactory ?? null,
          socialInbox: socialInbox ?? null,
        };
```

- [ ] **Step 6: Verify the destructuring positions match exactly**

This is the same class of bug a prior session task caught the hard way: the `Promise.all([...])` array and the destructured variable list on the left must stay in the EXACT same order, one-to-one, or every value after a mismatch silently shifts to the wrong variable. Before moving on, list both in order and check them against each other by hand:

Destructured names: `curiosity, repoScout, businessScout, freeTools, github, tidy, newsletters, gigs, gigsCheckWins, leadscanFound, kdpScan, kdpGenerate, mediaFactory, socialInbox, healResult`

Array entries (in order): `curiosity` → `repoScout` (search scout, AI agent frameworks) → `businessScout` (search scout, business tools) → `freeTools` (search freeApis) → `github` (connectors sync) → `tidy` (janitor tidy) → `newsletters` (newsletter readDaily) → `gigs` (gigfinder search) → `gigsCheckWins` (gigfinder checkWins) → `leadscanFound` (leadscan findLeads — the one you just added) → `kdpScan` (kdp scan) → `kdpGenerate` (kdpGenerateIfRoom) → `mediaFactory` (mediaFactory autoCycle) → `socialInbox` (social pollInbox) → `healResult` (codebase heal or Promise.resolve(undefined)).

14 names before your addition, 15 after — confirm both sides show exactly 15 now, in this exact order, with `leadscanFound` at position 10 on both sides.

- [ ] **Step 7: Run the orchestrator and app test suites to confirm nothing broke**

Run: `pnpm exec vitest run packages/orchestrator`
Expected: All existing tests still pass (this repo's orchestrator tests only exercise the pure `optional`/`deriveTopic`/`reelToPublishInput` helpers directly, same as the gigfinder checkWins wiring before it — no dedicated per-step wiring test exists to extend).

Run: `pnpm exec vitest run packages/app`
Expected: All existing tests still pass.

- [ ] **Step 8: Typecheck**

Run: `pnpm typecheck`
Expected: No errors. (If this fails with a destructuring-count or type mismatch, re-check Step 6 — that's exactly the class of bug a wrong typecheck result here would be catching.)

- [ ] **Step 9: Commit**

```bash
git add packages/orchestrator/package.json packages/orchestrator/src/plugin.ts pnpm-lock.yaml
git commit -m "feat(orchestrator): run leadscan.findLeads every cycle, one niche/city per hour

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Full suite, push, deploy

**Files:** none (verification + deploy only)

- [ ] **Step 1: Run the entire test suite**

Run: `pnpm test`
Expected: All tests pass (the full existing suite + the 7 new tests from Task 1).

- [ ] **Step 2: Typecheck the whole repo**

Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 3: Push**

```bash
git push origin main
```

- [ ] **Step 4: Deploy to the VPS**

Same pattern as every other hourly-cycle wiring change this session — no display needed, no new real-world account touched, just reads Gemini + writes to the lead registry, both already-existing, already-configured capabilities.

```bash
scp -i ~/.ssh/atlas_deploy packages/leadscan/src/*.ts root@72.62.168.207:/opt/atlas/app/packages/leadscan/src/
scp -i ~/.ssh/atlas_deploy packages/orchestrator/src/plugin.ts root@72.62.168.207:/opt/atlas/app/packages/orchestrator/src/
scp -i ~/.ssh/atlas_deploy packages/orchestrator/package.json root@72.62.168.207:/opt/atlas/app/packages/orchestrator/
scp -i ~/.ssh/atlas_deploy pnpm-lock.yaml root@72.62.168.207:/opt/atlas/app/
ssh -i ~/.ssh/atlas_deploy root@72.62.168.207 "docker restart atlas && sleep 12 && curl -s -o /dev/null -w '%{http_code}\n' localhost:4317/api/health"
```

Expected: the final `curl` prints `200`.

- [ ] **Step 5: Spot-check the deploy logs**

```bash
ssh -i ~/.ssh/atlas_deploy root@72.62.168.207 "docker logs atlas --tail 50"
```

Expected: no new errors related to `leadscan` or `orchestrator`. Given Gemini is currently at its daily quota ceiling (known, tracked separately — see project memory), the first several hours of `findLeads` calls may show up as recorded (non-fatal) cycle-health failures with a 429 quota message — that's expected given the current quota state, not a deploy problem, and will start succeeding once the quota issue is resolved or resets.

---
