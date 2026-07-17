# Run Ledger + Live Map (Phase 0 + 1 of "ATLAS closer to Paperclip")

## Context

Mat wants ATLAS to feel more like Paperclip — the AI-run-business app he's been
studying — specifically: a visible org chart, a task/issue tracker, per-agent
run history with transcripts, and a budget view. Those three later phases
(tracker, history, budget) all need the same missing piece: a structured
record of "agent X ran at time Y, here's what happened." That record doesn't
exist today — plugin invocations just happen and, at best, leave a memory
note. This spec covers the first two phases of the roadmap:

- **Phase 0**: a persistent Run Ledger, built by upgrading the existing
  `AuditLog` rather than adding a parallel system.
- **Phase 1**: the existing Living Map (`packages/server/src/html.ts`, the
  `#tab-map` section) shows live run status pulled from that ledger, instead
  of being a static hover-to-highlight diagram.

Phases 2–4 (Tasks/Issues tracker, per-agent run history with transcripts,
budget/cost view) are follow-on specs that read from the same ledger; they are
explicitly out of scope here.

## Why upgrade AuditLog instead of building something new

`packages/core/src/atlas.ts` already routes every `Atlas.invoke()` and
`ctx.call()` through `this.audit.record(...)` (see `atlas.ts:118-123` and the
context's `call` handler). This is the single existing choke point every
agent invocation already passes through — chat's command router, the nightly
sweep, manual UI actions, everything. Building a second, parallel "run
tracking" system alongside it would mean two sources of truth for the same
event. The existing `AuditLog` (`packages/core/src/audit.ts`) has two gaps
that make it unusable as a Paperclip-style ledger today:

1. **No persistence** — `MemoryAuditSink` is the default sink; every entry is
   lost on restart.
2. **No completion tracking** — `record()` is called once, before the
   handler runs, with `decision: "allow"` and no outcome. There's no second
   write for success/failure, duration, or a result summary.

## Design

### 1. Persistent sink (`packages/core/src/audit.ts`)

Add a `JsonFileAuditSink` implementing the existing `AuditSink` interface,
following the exact pattern already established in
`packages/memory/src/stores.ts` (`JsonFileStore`): an in-memory cache backed
by a JSON file, loaded lazily, written on every `write()`. Stored at
`data/audit-log.json`, consistent with where `data/temp` and other ATLAS
state already lives. `MemoryAuditSink` stays as-is for tests (matches how
`InMemoryStore` and `JsonFileStore` coexist in the memory package today).

### 2. Completion tracking (`AuditEntry` + `Atlas.invoke`)

Extend `AuditEntry` with the fields a "run" needs:

```ts
export interface AuditEntry {
  id: string;              // new — stable id so a start+end pair can be joined
  timestamp: string;       // existing — start time
  actor: string;           // existing
  action: string;          // existing
  decision: "allow" | "deny" | "pending";
  outcome?: string;
  metadata?: Record<string, unknown>;
  // new fields:
  status?: "running" | "done" | "failed";
  endedAt?: string;
  durationMs?: number;
  error?: string;          // present only when status === "failed"
}
```

`Atlas.invoke()` changes from one `record()` call to a start/finish pair: it
records a `status: "running"` entry immediately (as today, before calling the
handler), then on completion — success or thrown error — records a second
entry with the same `id`, `status: "done"` or `"failed"`, `endedAt`,
`durationMs`, and (on failure) `error: String(err)`. `ctx.call()` gets the
same treatment for consistency, since plugin-to-plugin calls are just as much
a "run" as an owner-console invoke — today it only records a single
pre-handler "allow" entry and never logs what the handler actually did.

`ctx.act()` (`atlas.ts:149-163`) needs the same fix for a different reason:
it already records a start entry (implicitly, via the guardian-check log) and
a success entry (`outcome: "ok"`) after `run()` resolves — but `run()` isn't
wrapped in a try/catch, so if it throws, the success `record()` call is
skipped entirely and **no completion entry is written at all**. The audit
trail for a failed `act()` currently just goes silent. This is fixed as part
of the same change: wrap `run()` in try/catch, write a `status: "failed"`
entry with the error on catch, then rethrow so callers' existing error
handling is unaffected.

The outcome summary is a short, truncated stringification of the handler's
return value (or the error message) — same truncation approach already used
elsewhere in the codebase (e.g. `server.ts`'s `.slice(0, 300)` pattern for
memory content) — never the full payload, to keep the ledger file from
growing unbounded with large results.

### 3. Query surface (`packages/server/src/server.ts`)

New endpoint `GET /api/runs`, owner-gated the same way existing `/api/*`
routes are (`authed(req)` check). Query params: `agent` (matches `actor`),
`status`, `since`/`until` (ISO timestamps), `limit` (default 50, matches the
existing pagination style used by `/api/chats`). Reads via a new method on
`AuditLog`, e.g. `AuditLog.query(filter)`, rather than exposing the raw sink.

### 4. Live map (`packages/server/src/html.ts`)

`/api/status` (already the source of the map's `data.agents` list) gets one
more field: `runningAgents: string[]` — actor names with an open `"running"`
entry (started but not yet completed) in the ledger. The map's render
function (`packages/server/src/html.ts` around line 707) adds a CSS pulse
class to a node when its agent name is in `runningAgents`, and briefly
flashes red (a timed class removed after ~2s, same timer pattern as other
transient UI states in this file) when a fresh `/api/status` poll shows an
agent's most recent run flipped to `failed` since the last poll.

Hover behavior (`mapInfo` text, `html.ts:735`) extends to show the agent's
last 3 runs from `/api/runs?agent=X&limit=3` — timestamp, status, outcome
summary — instead of just the agent's label.

### Error handling

- If the ledger file is missing/corrupt, `JsonFileAuditSink` starts empty
  (same recovery behavior as `JsonFileStore.load()` — catch and default to
  `[]`) rather than crashing ATLAS startup.
- If `/api/runs` fails for any reason, the map falls back to its current
  static (non-live) behavior — a live-status enhancement failing must never
  break the map's existing hover/click functionality.

### Testing

- `audit.test.ts` (new, alongside existing `packages/core/test/`): a run
  that succeeds produces two entries (running → done) joined by `id`, with
  `durationMs` populated; a run that throws produces (running → failed) with
  `error` set; `JsonFileAuditSink` persists across a fresh instance reading
  the same file (mirrors how `JsonFileStore`'s tests already verify
  restart-survival).
- `server` package: a test for `/api/runs` filtering by agent/status/time.
- Existing `atlas.test.ts` / plugin tests must keep passing unchanged — this
  is additive to `AuditEntry`, not a breaking change to the `invoke`/`call`
  contract plugins see.

## Explicitly out of scope for this spec

- Tasks/Issues tracker UI (Phase 2)
- Per-agent run-history page with full transcripts (Phase 3)
- Budget/cost aggregation view (Phase 4)
- Any change to the actual org-chart *structure* (reporting hierarchy) — this
  spec only makes the existing map show live status, it doesn't restructure
  what the map represents.
