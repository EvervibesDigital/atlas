# ATLAS — AI That Learns, Acts & Scales

ATLAS is a modular, plugin-first **AI Operating System**: a long-lived platform
that plans, acts (with human approval), learns from what happens, and runs
multiple businesses — while staying maintainable, secure, and endlessly
extensible.

This is **not** a chatbot. It is a kernel + a growing set of plugins.

## Status

**Phase 0 — Foundations: complete.** The kernel frame is built and proven by an
automated dependability gate (17 passing tests).

| Layer | Module | State |
| --- | --- | --- |
| Kernel | Plugin runtime (`Atlas`) | ✅ |
| Kernel | Event Bus | ✅ |
| Kernel | Config & Secrets Vault | ✅ |
| Kernel | Audit Log | ✅ |
| Guardian | Policy engine + 2 security seams | ✅ |
| Proof | `hello` plugin (dependability gate) | ✅ |

Next: **Phase 1 — Kernel** (Memory service on Postgres+pgvector, Brain Router
over free LLMs, Executive planner, Approval Gateway). See
`docs/architecture.md` and the plan.

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
