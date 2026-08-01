# Gig Work Package — Design

**Status:** Approved by Mat 2026-08-01 ("yes build it").

## Problem

The Gig Finder finds gigs and drafts bids, but nothing exists for *doing the won work*. Verified live: `packages/forge` and `packages/engineering` contain only an `index.ts` — they are empty stubs. `codebase.generate` produces ATLAS plugins, not client deliverables, and its own comment concedes it never writes a file ("In a real impl, this would use node:fs to write the file"). So the pipeline stops at "bid sent".

There are now 10 genuinely real gigs queued (Telegram bot + simple website, Python + Playwright automation, n8n workflow freelancer, React Native), so this is the next real bottleneck.

**The key realisation that shapes this design:** Mat already has a work-execution engine — Claude Code. It is what builds ATLAS itself. ATLAS should not attempt a worse copy of it. It should produce the input that makes it fast.

## Scope

**In scope:** turning a won gig into a *work package* — scope summary, deliverables, questions for the client, assumptions, and a ready-to-paste Claude Code handoff prompt — stored on the gig and surfaced for approval.

**Out of scope, deliberately:**
- **Autonomous generation of client deliverables.** Unreviewed AI code shipping under Mat's name is the same class of reputational harm as the broken bid fragment found earlier today, and it would need heavy AI quota that is currently exhausted. Mat chose the work-package model explicitly; autonomous generation can layer on later without redesign.
- Auto-submitting anything to a client (paused by Mat earlier for good reason).
- KDP work execution — already exists and works (30 books generated 2026-07-25 → 07-31). KDP's gap is publishing, not execution; that is a separate piece of work.

## Architecture

### `packages/gigfinder/src/work-package.ts` — pure, testable

```ts
export interface WorkPackage {
  gigId: string;
  summary: string;            // what the client actually wants, plainly
  deliverables: string[];     // concrete list Mat is on the hook for
  questionsForClient: string[]; // genuine ambiguities, asked BEFORE starting
  assumptions: string[];      // what proceeds if they don't answer
  techApproach: string;       // tools/stack
  estimateDays: number;
  handoffPrompt: string;      // paste-into-Claude-Code prompt
  generatedBy: "brain" | "template";
}
```

Three exported functions:

- **`buildHandoffPrompt(gig, pkg)`** — pure and deterministic. Assembles the paste-ready prompt from the gig text plus the package fields. This is the payoff: one paste into Claude Code and the work gets built, using the tool Mat already has rather than a weaker reimplementation.
- **`templateWorkPackage(gig)`** — a deterministic package derived from the gig's own title/snippet/budget, with **no AI call at all**. Not merely a fallback: every AI provider is 429-quota-exhausted as of tonight, so a design that only works with AI would be a design that does not work today. This makes the feature useful immediately.
- **`isUsableWorkPackage(pkg)`** — the quality gate. Rejects a package with no deliverables, an empty summary, a summary that is obviously a truncated model artifact (same failure shape as the production bid fragment `"Delivery Estimate):* Depending on your clients'"`), or a nonsensical estimate. Consistent with the bid quality gate and the send/spend gates built earlier today: validate the output rather than trust the model.

### `gigfinder.planWork` op

`{ op: "planWork"; id: string }`. Loads the gig, asks the brain to extract requirements as JSON, validates the result with `isUsableWorkPackage`, and falls back to `templateWorkPackage(gig)` whenever the brain errors, is quota-blocked, returns unparseable JSON, or returns a package that fails the gate. Stores the result on the gig via the existing registry `update`, and returns it.

The op is only meaningful for a gig that has actually been won, but it is not restricted to `status === "won"` — Mat may reasonably want to plan work for a gig he is about to bid on, to sanity-check scope before committing. Refusing that would be a guess at his workflow, not a safety property.

### Storage

`WorkPackage` is added as an optional `workPackage?: WorkPackage` field on `Gig`. This follows how `draftBid` is already stored on the gig — no new file, no new store, and it travels with the gig through the existing list/approve/status flow.

## Error handling

Every failure path degrades to `templateWorkPackage` rather than throwing, because a deterministic package is always better than no package — the same reasoning as the bid quality gate preferring a coherent template over a broken model output. `planWork` throws only when the gig id does not exist, which is a caller error rather than a degraded result.

## Testing

- `buildHandoffPrompt` includes the gig title, every deliverable, the tech approach, and the client questions; and is deterministic (same input → identical output).
- `templateWorkPackage` produces a package that passes `isUsableWorkPackage` — otherwise the fallback would just swap one unusable artifact for another, exactly the trap the bid-gate test guards against.
- `isUsableWorkPackage` rejects: empty deliverables, empty summary, a truncated-fragment summary, a zero/negative estimate.
- `planWork` falls back to the template when the brain throws, and when the brain returns unparseable or gate-failing output — asserted with an injected failing brain, no network.
- No test performs a real brain call.

## Known limitations

1. **The package is only as good as the posting.** Reddit gig posts are often thin, so `questionsForClient` will frequently be the most valuable field — it makes the thinness explicit instead of hiding it behind confident-sounding scope.
2. **`generatedBy` records provenance** (`"brain"` vs `"template"`) so a template-derived package is never mistaken for extracted requirements. Template packages are structurally sound but generic.
3. Nothing here contacts the client. Sending the questions is a separate, human-approved step, consistent with every other outbound path in ATLAS.
