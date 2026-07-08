# ATLAS — AI That Learns, Acts & Scales

ATLAS is a modular, plugin-first **AI Operating System**: a long-lived platform
that plans, acts (with human approval), learns from what happens, and runs
multiple businesses — while staying maintainable, secure, and endlessly
extensible.

This is **not** a chatbot. It is a kernel + a growing set of plugins.

## Status

**Autonomous & feature-rich.** 118 passing tests, typecheck clean.
`pnpm start` boots 24 plugins · `pnpm cycle` runs an autonomous day · `pnpm status` shows readiness.

| Layer | Module | State |
| --- | --- | --- |
| Kernel | Plugin runtime (`Atlas`) | ✅ |
| Kernel | Event Bus | ✅ |
| Kernel | Config & Secrets Vault | ✅ |
| Kernel | Audit Log | ✅ |
| Kernel | Service registry (`provide`/`call`) | ✅ |
| Guardian | Policy engine + 2 security seams | ✅ |
| Brain Router | Model registry · scorer · fallback · cache | ✅ |
| Brain Router | Free provider adapters (Groq/OpenRouter/Gemini/stub) | ✅ |
| Memory | Semantic remember/search/recall/forget | ✅ |
| Memory | Pluggable store: in-memory · JSON file · (pgvector later) | ✅ |
| Executive | Objective → ordered, risk-tagged plan (plans only) | ✅ |
| Approval Gateway | Pending queue · approve/reject · granted events | ✅ |
| Personas | AI-influencer identity registry | ✅ |
| Creative | Reel script (Brain) + Pollinations images + captions | ✅ |
| Publishing | Instagram Reels validate · approval-gated · dry-run | ✅ |
| Learning | Reflection · confidence metrics · improvement proposals | ✅ |
| Research | Curiosity engine — ranks discoveries into a digest | ✅ |
| Business | COO — synthesizes metrics into a prioritized brief | ✅ |
| Opportunity | Scores opportunities by value vs effort | ✅ |
| Tech-Debt | Real scanner — TODO/FIXME + oversized files | ✅ |
| Strategy | 7-seat Board of Directors → verdict + risks | ✅ |
| CFO | Runway · forecasting · ROI (protects the money) | ✅ |
| Automation | Hunts repetitive work worth automating | ✅ |
| Simulation | "What happens if…" projections before you commit | ✅ |
| Analytics | Rolls metrics into headline KPIs | ✅ |
| Compliance | Catches FTC/#ad + income/health-claim risks pre-post | ✅ |
| Negotiation | Anchor/target/walk-away + ZOPA + tactics | ✅ |
| Detective | "Why is X down?" → ranked hypotheses + checks | ✅ |
| Engineering | Classifies eng tasks by type/risk; tech-debt audits | ✅ |
| Experiments | A/B lab — records trials, picks the winner | ✅ |
| Knowledge | Synthesizes lessons into playbooks | ✅ |
| Orchestrator | Autonomous daily loop — "the 3 things that matter today" | ✅ |
| App | Composition root — `pnpm start` / `pnpm cycle` | ✅ |
| Proof | `hello` plugin (dependability gate) | ✅ |

### The autonomous loop — `pnpm cycle`

One command runs a full day of ATLAS's work: assess the businesses (Business
brief) → pick today's topic → write a Reel (Creative) → sanity-check it
(Strategy Council) → queue it for approval (Publishing — gated on Mat) → gather
improvement proposals (Learning) and the pending-approval list → file a timeline
note → return a **morning report**. Offline-safe and posts nothing. A GitHub
Actions schedule (`.github/workflows/atlas-daily.yml`) runs it daily so ATLAS
works while you're at your day job.

### Phase 2 — Instagram Reels walking skeleton (READY, posts nothing)

The full faceless-influencer spine runs offline: **persona → Brain writes the
script → Creative builds a render-ready Reel (Pollinations images, captions,
hashtags) → Publishing validates it against Instagram's rules → routes it to the
Approval Gateway → on approval, a dry-run publisher shows the exact Instagram
browser recipe it *would* run → Memory records the lesson.**

Posting is deliberately gated twice: it needs (1) your approval and (2) a live
publisher swapped in for the default `DryRunPublisher`. Two real-world hookups
remain before going live: the final MP4 encode (edge-tts + ffmpeg/Remotion) and
your Instagram login session for the browser publisher.

### Phase 3 — Learning loop (built)

ATLAS now learns from every outcome. When a Reel publishes or an approval is
granted/rejected, the **Learning** layer auto-writes a reflection (the lesson)
to Memory, updates a **confidence metric** per category (persona, action, …),
and — when a category underperforms with enough evidence — generates an
**improvement proposal** for Mat to review. It never rewrites itself; proposals
are suggestions only. The walking-skeleton test proves the loop closes: after a
(dry-run) publish, ATLAS has recorded a success it can learn from.

### Phases 4 & 5 — departments + advanced systems (built)

**Departments:** Research (curiosity engine that ranks discoveries by
open-source/free/API/Docker/MCP), Business (a COO that turns Learning metrics
into a prioritized brief). **Advanced systems:** Opportunity Engine
(value-vs-effort scoring), Tech-Debt Hunter (a real scanner that flags
TODO/FIXME + oversized files — it can inspect ATLAS itself), Strategy Council (a
5-perspective debate that returns a verdict + risks), Experiment Lab (A/B tests
with statistically-gated winners), and Knowledge Synthesizer (merges lessons
into playbooks). Every one is a plugin on the same kernel, Guardian-gated and
audited.

The platform is now feature-complete per the constitution's core layers. What
remains is going live: the real MP4 encoder (edge-tts + ffmpeg/Remotion) and the
live Instagram browser publisher with Mat's session, swapped in at the
composition root. See `docs/architecture.md` and the plan.

### Memory

`ctx.call("memory", { op })` — `remember` a learning/outcome/preference,
`search` by meaning, `recent` by kind, or `forget`. Persists to a JSON file by
default (offline, no database), with the store swappable for Postgres+pgvector
later. Search is semantic via an offline, zero-cost token embedder.

### Brain Router

Any plugin calls one service — `ctx.call("brain", { prompt, needs })` — and the
router scores every *available* free model against the request's needs
(coding / reasoning / speed / privacy / cost …), picks the best, and falls back
automatically when a provider errors or is rate-limited. Identical prompts are
cached to stretch free tiers. With **no API keys**, an offline stub answers, so
ATLAS always runs. High-privacy requests are forced to a local/private model.

## Architecture at a glance

Every capability is a **plugin**. Plugins never touch the kernel or each other
directly — they get a scoped, Guardian-wrapped context and communicate through
events. Two rules are enforced in code and can never be bypassed:

- **Planners cannot execute.** (Seam 1)
- **Executors cannot change policy.** (Seam 2)

High-risk actions (deletes, installs, purchases, credential changes, …) always
return `pending` and wait for **human approval** — core principle #5, *human
approval overrides AI*.

## Repository layout

```
atlas/
├─ packages/
│  ├─ core/        @atlas/core     — the kernel (runtime, events, config, audit)
│  ├─ guardian/    @atlas/guardian — policy engine + security seams
│  └─ plugins/
│     └─ hello/    @atlas/plugin-hello — Phase 0 proof plugin
├─ docker-compose.yml   — Postgres + pgvector (for the Phase 1 memory layer)
└─ .github/workflows/   — CI: typecheck + tests on every push
```

## Develop

```bash
pnpm install
pnpm test        # run the whole suite
pnpm typecheck   # strict TypeScript check
```

Requires Node 22+, pnpm 11+. Docker is only needed once the memory layer lands
in Phase 1.
