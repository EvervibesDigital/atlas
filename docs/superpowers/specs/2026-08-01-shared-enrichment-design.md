# Shared Enrichment Capability — Design

**Status:** Approved by Mat 2026-08-01 ("yes build it"). Build-only — **no spending** this pass.

## Problem

Missing contact data is the same bottleneck across two of Mat's businesses, verified live 2026-08-01:

- **Surplus funds**: 68 leads, $2,228,811 estimated surplus, $130,727 estimated commission. **0 of 68 have an owner email**; 1 of 68 has a phone. The outreach path sends email, so the business is structurally unable to act despite being fully built.
- **Wholesale**: a June 2026 audit recorded 826 buyers with only 13 emails. Same shape, different table.

Mat asked whether he already had a skip tracer. He does: Twin's **`Batch Skip Tracer`** (`019f82af-8407-7bcb-aebd-f7d42cc92834`), which skip-traces US property addresses via the Twin platform tool `enrich_property` (`action: "property_skip_trace"`) at **$0.070 per matched property** — under $5 for all 68 surplus leads. It is complete and well-specified, but **has never run**: its only run record is the instruction build, not an execution on real data.

Two constraints Mat set: **build it but spend nothing**, and **Twin billing is not yet set up**.

## Scope

**In scope:** a shared `@atlas/enrichment` capability that orchestrates the existing Twin agent; a tested US address parser; a surplus adapter that reads leads needing contact info from the existing Google Sheet; a free `preview` op; a cost-gated `enrich` op.

**Out of scope, deliberately:**
- **Rebuilding skip tracing.** Twin's agent works off a platform tool; re-implementing it would be building a workaround around something Mat already has.
- **The wholesale adapter.** The "826 buyers / 13 emails" figure is from a June audit and no endpoint for reading those buyers has been verified. Building against an unverified assumption is precisely what produced 128 junk gigs earlier today. Add it once the endpoint is confirmed — it is a small addition once the core exists.
- **Any actual spending.** Nothing in this pass triggers a paid run.
- **Writing results back to the surplus Sheet.** Deferred until we have seen real skip-trace output and know its shape; writing to Mat's live business data against an unverified format is not worth the risk.

## Architecture

### 1. `parseUsAddress(raw: string)` — pure, tested

Real data forced this to be a first-class unit. Measured across the 59 surplus mailing addresses:

| Shape | Count |
|---|---|
| 0 commas, ends in STATE + ZIP (`1234 MAIN ST TAMPA FL 33601`) | 31 |
| 1 comma, ends in STATE + ZIP | 13 |
| 2 commas, ends in STATE + ZIP | 8 |
| no trailing STATE + ZIP | 7 |

Only 8 of 59 split cleanly on commas, so comma-splitting alone would mangle 86% of the data. **52 of 59 (88%) end in a recognizable `STATE ZIP`**, which is the reliable anchor.

Algorithm: match and strip a trailing `\b([A-Z]{2})\s+(\d{5})(-\d{4})?$`; from the remainder, find the **last street-suffix token** (`ST, AVE, RD, BLVD, DR, LN, CT, WAY, PL, TER, CIR, HWY, PKWY, TRL, LOOP`) — everything through that token is `street`, everything after it is `city`. Commas, where present, are treated as separators before falling back to the suffix heuristic.

Returns `{street, city, state, zip, confidence: "high" | "low"} | null`. `high` means state+zip matched *and* a street suffix was found; `low` means it parsed partially (e.g. no suffix token, so the street/city split is a guess). `null` means no state+zip anchor — unusable without more work.

Sending a `low`-confidence address is still worthwhile: the Twin agent's own instructions say it parses unstructured text with its own tools, so an imperfect split is not a wasted charge. But `preview` reports the breakdown so Mat sees data quality before paying.

### 2. `TwinEnrichmentClient` — thin REST client

`startRun(agentId, userMessage)` → `POST https://build.twin.so/v1/agents/{id}/runs` with `{run_mode: "run", user_message}`, auth header `x-api-key`. `getRunEvents(agentId, runId)` → `GET .../runs/{runId}/events`. `waitForRun(...)` polls until finished with a bounded timeout. Injectable `fetch` so tests never touch the network.

### 3. `parseEnrichmentResults(events)` — the explicitly unverified part

The agent has never run, so **its output shape is unknown**. This is isolated into one pure function with its own tests built from the agent's documented contract (it reports matched phones/emails per property). When billing is enabled and real output is seen, there is exactly one small tested function to correct — rather than a wrong assumption spread across the codebase. Its doc comment must say so plainly.

### 4. `@atlas/enrichment` plugin — two ops split by cost

- **`{op: "preview", source: "surplus", limit?}`** — **free, spends nothing.** Reads leads needing contact info, runs `parseUsAddress` over them, returns `{total, highConfidence, lowConfidence, unusable, estimatedCostUsd}` where cost is `matchable * 0.07`. Useful immediately, before billing exists.
- **`{op: "enrich", targets, confirmCost: true}`** — the paid path. **Throws unless `confirmCost === true` is passed explicitly.**

The cost gate is a deliberate structural safeguard, not ceremony. Many capabilities have been wired into the hourly cycle this session, and a missing permission silently broke a real feature for weeks. A capability that spends money must be *structurally* incapable of being added to an automated loop by accident; a required literal `confirmCost: true` cannot be satisfied by an absent-minded `optional(ctx.call, "enrichment", {op: "enrich"})`. This mirrors the cost-confirmation gate already present in the Twin agent's own instructions.

Manifest permissions: `["secret:*", "call:memory"]`. It is **not** added to the orchestrator's cycle, and the orchestrator is **not** granted `call:enrichment` — deliberately, per the gate above.

### 5. Surplus adapter

Reuses the existing `GoogleSheetsClient` and the known leads sheet (`1bkr0CK7...`). Selects rows where the owner email is empty, mapping `owner mailing address` → `parseUsAddress`, and passing `owner name` through as `firstName`/`lastName` when splittable, since the agent's spec states name fields measurably improve match quality.

## Error handling

`parseUsAddress` returns `null` rather than throwing on unparseable input — one bad row must never abort a batch. `TwinEnrichmentClient` surfaces non-2xx responses as errors carrying the status and a truncated body, matching the existing `TwinClient` convention in `@atlas/surplus`. A run that exceeds the poll timeout throws a clear "run did not finish" error rather than hanging. `enrich` without `confirmCost` throws a message that names the flag explicitly, so the fix is obvious.

## Testing

- `parseUsAddress`: cases covering each measured real-world shape — no-comma with state+zip, one comma, two commas, missing zip, and a `null` case. Fixtures are **synthetic addresses matching the measured shapes**, never real owner PII from the sheet.
- Cost gate: `enrich` without `confirmCost` throws; with it, proceeds (against an injected fake fetch — no real spend, no network).
- `parseEnrichmentResults`: tests against the agent's documented output contract, clearly marked as provisional until real output is observed.
- `preview` returns a correct breakdown and cost estimate from a fake sheet source.
- No test performs a real Twin run or spends money.

## Known limitations

1. **`parseEnrichmentResults` is written against an unobserved contract.** It is the one part of this design that cannot be verified until billing is enabled. Isolated and tested precisely so correcting it is a one-function change.
2. 7 of 59 surplus addresses have no state+zip anchor and will be reported as `unusable`. They are not silently dropped — `preview` counts them so Mat knows what is being skipped.
3. The `property address` column is unreliable as an address (samples include case/parcel-number shapes like `F23-456`), so the adapter uses `owner mailing address` and ignores it.
4. Results are not written back to the Sheet this pass (see Scope). Enriched output is returned to the caller only.
5. Nothing here is wired into the hourly cycle, by design. Enrichment is triggered explicitly.
