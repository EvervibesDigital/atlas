# ATLAS — AI That Learns, Acts & Scales

ATLAS is a modular, plugin-first **AI Operating System**: a long-lived platform
that plans, acts (with human approval), learns from what happens, and runs
multiple businesses — while staying maintainable, secure, and endlessly
extensible.

This is **not** a chatbot. It is a kernel + a growing set of plugins.

## Status

**Phases 0–2 complete.** 62 passing tests, typecheck clean. `pnpm start` boots ATLAS.

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
| App | Composition root — `pnpm start` boots everything | ✅ |
| Proof | `hello` plugin (dependability gate) | ✅ |

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

Next: wire the MP4 encoder + live Instagram browser publisher; then Phase 3
(learning loops). See `docs/architecture.md` and the plan.

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
