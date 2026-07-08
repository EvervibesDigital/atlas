# ATLAS Architecture

## The layered system

```
INTERFACE     Command Center UI · Daily Approval List · Reports
ADVANCED      Opportunity · Tech-Debt · Knowledge Synth · Experiment Lab · Strategy Council
DEPARTMENTS   Engineering · Research · Business · Creative · Publishing   (each a plugin)
EXECUTIVE     Plans, never executes: decompose · prioritize · delegate · risk-score · approve
GUARDIAN      Policy engine · approval gateway · sandbox · planner≠executor · secrets broker
BRAIN ROUTER  Model registry · request scorer · provider adapters · fallback · cache
MEMORY        Semantic · Business · Project · Agent · Success/Failure · Preference · Timeline
OBSERVATION   Browser · Clipboard · Screenshot/OCR · Voice · File watchers
KERNEL        Plugin runtime · Event bus · Scheduler · Audit log · Config/Secrets · Docker
```

Lower layers must be **dependable before** higher layers depend on them. We
build one layer to production quality (tests + review + working demo), prove it,
then move up.

## Phase 0 — the Kernel frame (built)

### Components

- **`Atlas` (kernel)** — `packages/core/src/atlas.ts`. Loads plugins and hands
  each one a scoped `AtlasContext`. A plugin can only: subscribe/emit events,
  read non-secret config, request a secret (brokered), and attempt actions —
  all audited, all Guardian-checked. It cannot reach the raw kernel, config
  secrets, or another plugin.
- **Event Bus** — `packages/core/src/events.ts`. Sequential, deterministic
  pub/sub. The only way modules talk to each other.
- **Config & Secrets Vault** — `packages/core/src/config.ts`. Secrets never
  leak through `get()`; they are only released via the Guardian-checked
  `secret()` path.
- **Audit Log** — `packages/core/src/audit.ts`. Every action, event, secret
  request, and Guardian verdict is recorded. Pluggable sink (memory now,
  Postgres later).
- **Guardian** — `packages/guardian/src/guardian.ts`. The policy engine and the
  two seams.

### The Plugin Contract

```ts
interface Plugin {
  manifest: {
    name: string;
    version: string;
    capabilities: string[];   // what it provides
    permissions: string[];    // what it may do  (exact | "prefix.*" | "*")
    role: "planner" | "executor" | "policy";
  };
  register(ctx: AtlasContext): void | Promise<void>;
}
```

### Security seams (enforced, not advisory)

1. **Planner ≠ Executor** — a `planner` attempting an `execute*` action is denied.
2. **Executor ≠ Policy** — an `executor` attempting a `policy*`/`guardian*`
   action is denied.
3. **Human approval** — actions in `APPROVAL_REQUIRED` (delete, install, run
   script, prod change, money, account create, purchase, credential change,
   system modify) always return `pending`, regardless of permissions.

### Dependability gate (how we know it works)

`packages/plugins/hello/test/hello.test.ts` proves, end to end, that: a plugin
loads; its emitted event reaches a listener; the permitted action and the event
are audited; and a planner trying to execute is **blocked before its callback
runs**, with the denial recorded. 17 tests pass across the workspace.

## Phase 1 — Kernel layer (built)

All four are plugins on the Phase 0 frame, reachable via the service registry
(`ctx.call`), Guardian-gated and audited.

- **Brain Router** (`@atlas/brain`, service `brain`) — scores every available
  free model against a request's needs and routes to the best, with automatic
  fallback, a prompt cache, and an offline stub so it runs with no keys.
  High-privacy requests are forced to a local/private model.
- **Memory** (`@atlas/memory`, service `memory`) — semantic remember / search /
  recent / forget over a pluggable store (in-memory · JSON-file · pgvector
  later), using an offline token embedder.
- **Executive** (`@atlas/executive`, service `executive`, role `planner`) —
  decomposes an objective into a topologically-ordered, risk-tagged plan;
  auto-dispatches L0–L1 tasks (`task.ready` event) and routes L2–L3 to approval.
- **Approval Gateway** (`@atlas/approvals`, service `approvals`, role `policy`) —
  the pending queue; `approve`/`reject` emit `approval.granted`/`.rejected`.

### How they connect (the spine)

```
objective ─▶ Executive.plan ─▶ risk ≤ L1 ─▶ emit task.ready ─▶ (executor, Phase 2)
                              └▶ risk ≥ L2 ─▶ approvals.request ─▶ Mat ─▶ approval.granted
Brain + Memory are called by any plugin via ctx.call("brain"|"memory", …).
```

## What's next — Phase 2 (Walking Skeleton)

Prove the spine with one real vertical: the faceless AI-influencer. Creative +
Publishing department plugins run through Executive → Brain → render (edge-tts +
Pollinations + Remotion) → queue → daily approval → browser post, with Memory
recording what worked.
