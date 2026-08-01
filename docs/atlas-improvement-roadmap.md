# ATLAS Improvement Roadmap — 2026-08-01

Everything below is grounded in the code as it exists today, not memory. Verified by
inspection this session: **33 services, ~98 distinct ops, 101 API routes**, 647 tests
across 117 files passing, live on `72.62.168.207:4317` (health 200).

---

## Part 0 — Ground truth (what ATLAS actually has right now)

**Brain providers (`packages/brain/src/adapters/`):** anthropic, gemini, groq,
huggingface, openrouter, ollama, stub. Router priority Gemini → Groq → HuggingFace →
Ollama → stub.

**Image generation — two independent paths, both real:**
- `packages/media-factory/src/image-gen.ts` — Gemini `gemini-2.5-flash-image`
  ("Nano Banana"), with reference-image support for keeping the *same face* across a
  persona's shots. `NANO_BANANA_PRO = "gemini-3-pro-image"` is already coded and
  selectable, just not defaulted.
- `packages/creative/src/pollinations.ts` — free, keyless Flux URLs with a fixed seed
  per persona. No API call needed to build the link.

**Video generation:** `packages/publishing/src/montage-renderer.ts` — `ffmpeg-static` +
Piper TTS narration + burned SRT captions, with a `reviewRender` step that checks the
output rather than trusting ffmpeg's exit code. Falls back to no-op when Piper isn't
configured. Queue in `video-queue.ts`, and as of today finished jobs auto-request a
publish approval.

**Coding ability — three packages, wildly uneven:**
- `packages/forge` (159 lines) — ATLAS writes its own plugins from a *fixed template*
  where only text is injected, so a forged plugin always compiles and can't smuggle
  arbitrary code. Drafts → `forge/drafts`, going live is approval-gated + backed up.
- `packages/codebase` (scan.ts 145, healer.ts 217) — real scan + self-heal.
- `packages/engineering` (56 lines) — **classify() only.** It sorts a task into
  feature/bug/refactor/chore/security and assigns a risk level. That's it. The comment
  says the quiet part: *"The heavy code-writing is done by Claude Code itself."*

**Secrets actually consumed by a capability:**

| Key | Read by |
|---|---|
| `GEMINI_API_KEY` | brain, leadscan, media-factory |
| `GROQ_API_KEY` `OPENROUTER_API_KEY` `ANTHROPIC_API_KEY` `HUGGINGFACE_API_KEY` | brain |
| `TWIN_API_KEY` | enrichment, surplus |
| `GOOGLE_SHEETS_CLIENT_EMAIL` / `_PRIVATE_KEY` | surplus |
| `EVERVIBES_APP_URL` + `KDP_CRON_SECRET` | kdp, wholesale, cfo |
| `N8N_API_KEY` | outreach |
| `META_APP_ID` `META_APP_SECRET` `SOCIAL_LOGIN_CONFIG_ID` `SOCIAL_TOKEN_KEY` | social |
| `TAVILY_API_KEY` `SERPER_API_KEY` `GITHUB_TOKEN` | search |
| `GITHUB_TOKEN` `VERCEL_TOKEN` `SUPABASE_TOKEN` | connectors |
| `EMAIL_SMTP_HOST` / `EMAIL_USER` / `EMAIL_PASS` | email |
| `DATABASE_URL` | media-factory (Supabase) |

**Secrets the UI invites you to paste that NOTHING reads.** `server.ts:82-89` has
detectors for `STRIPE_RESTRICTED_KEY`, `RESEND_API_KEY`, `APIFY_API_KEY`,
`POSTHOG_API_KEY`, `PINTEREST_TOKEN`, `SLACK_TOKEN` — the paste-a-blob UI will happily
detect, save, and encrypt them, and no `ctx.secret()` call anywhere consumes any of the
six. **This is the same "built but unreachable" bug class, now in the key layer.** Fixing
it is Part 1's second test.

---

## Part 1 — The reachability audit (do this first)

### Why this and not features

The same bug appeared **six separate times** today:

1. Reels rendered into a void — no publish step
2. `call:social` silently Guardian-denied for weeks
3. 128 junk gigs from a URL that was fetched then discarded
4. `planWork` wired to nothing
5. `cfo` / `knowledge` / `archaeologist` had no routes
6. Leads marked `contacted` with nothing ever sent

Every one is the same shape: **code that works, that nothing calls.** Tests passed in all
six cases, because tests check that a function is correct — not that anyone reaches it.
Six occurrences in one day is not bad luck, it's a missing structural guarantee. Building
more features on this substrate just manufactures more of them.

### The design

A test — `packages/server/test/reachability.test.ts`, so it runs in the existing suite
and CI with no new tooling — that does four extractions and one set-difference.

**Step 1: enumerate what exists.** Parse every `packages/*/src/plugin.ts` for
`ctx.provide("<service>", ...)` and the `op === "<name>"` comparisons inside it. That
yields the universe of `(service, op)` pairs. Today that's 33 services and ~98 ops.

**Step 2: enumerate the three ways an op can be reached.**
- **By route** — `packages/server/src/server.ts`, every `call("<service>", { op: ... })`
  inside a route handler body.
- **By cycle** — `packages/orchestrator/src/plugin.ts` and `packages/app/src/main-cycle.ts`,
  every `ctx.call(...)`. This is the autonomous path.
- **By UI** — `packages/server/src/html.ts`, every `api("/api/...")` fetch. An op with a
  route but no button is reachable by curl and invisible to Mat, which is how the CFO
  routes sat unused.

**Step 3: subtract.** Anything in step 1 not present in step 2 is unreachable.

**Step 4: allowlist with a mandatory reason.** A JSON file,
`packages/server/test/reachability-allowlist.json`, shaped:

```json
{ "publishing.renderQueuedJob": "called by the background worker tick, not by a route" }
```

An entry with an empty reason fails the test. This is the whole point: an intentional
internal op is *documented*, not silent. The failure message must name the op and say
which of the three wirings it's missing — `"mediaFactory.produceVideo is defined but has
no route, no cycle call, and no UI button"` — so the fix is obvious without reading the
audit's source.

**Step 5: the dead-key test, same file.** Every entry in `server.ts`'s `KEY_DETECTORS`
must either be read by some `ctx.secret("NAME")` call, or carry an explicit
`consumedBy: null, note: "<why it's here anyway>"`. This immediately flags the six dead
detectors above and stops ATLAS from asking Mat for keys it can't use.

### Status honesty (the companion pattern)

The audit catches *unreachable*. The other half is *reachable but non-functional* — an op
with a route, a button, and no API key behind it. Add a `GET /api/capabilities` that, per
service, reports one of:

- `ready` — wired and its secrets are present
- `needs-key: TWIN_API_KEY` — wired, secret missing
- `unreachable` — failed the audit (shouldn't happen once CI is green)
- `stub` — provider fell through to the stub adapter

Surface it as a single panel in the UI. Right now the only way to learn that surplus can't
trace is to run it and read an error. **This one panel would have surfaced four of today's
six bugs before they cost a week each.**

### Real-data fixtures

The third guarantee, already proven twice today. `ST PETERSBURG` broke the address parser
(ST is both "Street" and "Saint"); `[Hiring]` in r/forhire titles would have made the
work-package gate reject every real gig. Both were caught **only** because the fixture was
real. Convention: `packages/<pkg>/test/fixtures/real-*.json`, captured from production,
PII anonymized, with a header comment saying where it came from and when.

---

## Part 2 — Maximizing ATLAS's coding ability

Honest framing first: **ATLAS does not currently write meaningful code.** `forge` writes
prompt-driven plugins from a fixed template — genuinely useful and genuinely safe, but the
template does the compiling, not the model. `engineering` classifies and stops. The heavy
lifting is Claude Code, i.e. me, in a session like this one. That's not a flaw to hide, it's
the current architecture, and the upgrade path is to make ATLAS a *better client of a coding
model* rather than to pretend it's one.

Four upgrades, in order of value:

**2a. Give `engineering` an execution arm.** It classifies a task and then does nothing with
it. Wire `classify()` → work package → `codebase.scan` for the relevant files → a Brain call
with the file contents → a **diff proposed as an approval**, never applied directly. The gig
work-package + handoff-prompt machinery built today is exactly this shape already; point it
at ATLAS's own repo instead of at a client gig. This is the single biggest coding-ability
jump available and needs no new API key beyond an Anthropic one.

**2b. Anthropic key for the Brain, used specifically for code.** Gemini/Groq are fine for
copy and classification; they are noticeably weaker at multi-file code edits. Add a
`purpose: "code"` hint to the Brain router so code tasks prefer Anthropic and everything
else keeps using the free tiers. Cost stays near zero because code tasks are rare and short.

**2c. A test-and-revert loop around `codebase.healer`.** The healer already proposes fixes.
Add: apply to a scratch copy → run `pnpm test` → keep only if green, else discard and report.
This is the difference between "suggests a fix" and "lands a verified fix," and it's ~80
lines because the test command already exists.

**2d. Aider / OpenHands as a fallback executor.** Both are already installed locally (Aider
CLI, OpenHands Docker on :3333). A `codebase.delegate` op that shells out to Aider for a
bounded task, with the diff still gated behind approval, gives ATLAS a real code executor
that runs unattended on the VPS. Lower priority than 2a — do it only if 2a's approval loop
proves too slow.

**What NOT to build:** an autonomous code-merge loop. Every one of the six bugs today was
caught by a human reading output. Removing that reader is the wrong direction.

---

## Part 3 — Maximizing image and video generation

### Images

The bones are good — the reference-image path in `image-gen.ts` is the hard part and it's
already written. Three additions:

**3a. Default to Nano Banana Pro (`gemini-3-pro-image`) with automatic fallback.** The code
already accepts it; it's not the default because your key's access was unconfirmed. Make it:
try Pro, fall back to Flash on a 403/404, and log which one ran. Zero risk, immediate
quality jump. **This needs nothing from you but a working `GEMINI_API_KEY`.**

**3b. Expose reference-image consistency in the UI.** `generateImage(prompt, key, {
references })` keeps a persona's face stable across shots. Nothing in the UI passes
`references` today — a persona's first generated image should be stored and auto-passed as
the reference for every subsequent one. This is the difference between "AI images" and "a
consistent creator."

**3c. A paid quality tier, only if 3a isn't enough.** fal.ai or Replicate for FLUX 1.1 Pro,
roughly $0.04/image. Keep Pollinations as the free tier for volume and Gemini as the default.
Don't add this until you've seen Pro's output — it may be unnecessary.

### Video

Today's renderer is a **montage**: stills + Piper narration + captions. That's a legitimate
format and it's the right free default. But it is not generative video, and for Reels the
gap is visible.

**3d. Ken Burns motion on the stills.** ffmpeg `zoompan` — a slow zoom/pan per image instead
of a hard cut. Purely local, no key, no cost, and it's the single largest perceived-quality
improvement available. Do this first.

**3e. Music bed + ducking.** A royalty-free loop mixed under the narration with ffmpeg
`sidechaincompress` so speech stays clear. Free. Use Pixabay/Uppbeat licensed tracks committed
to the repo — do **not** use Suno or any AI music service with unclear commercial terms, since
this goes out under your name.

**3f. Real generative video — Veo 3 via the Gemini API.** Same `GEMINI_API_KEY` you already
have. It's genuinely expensive (dollars per clip, not cents), so the right shape is: montage
by default, Veo for a single hero shot, gated behind `confirmCost: true` exactly like the
enrichment spend gate. **Do not wire this into the autonomous cycle.**

**3g. Cheaper generative option:** LTX-Video or Wan 2.2 on fal.ai/Replicate, ~$0.10-0.30/clip.
Worth it if 3f's pricing turns out prohibitive.

**3h. Faster narration:** Piper is fine and free. If voice quality becomes the bottleneck,
ElevenLabs free tier is 10k chars/month — enough for ~10 Reels. Not urgent.

---

## Part 4 — The complete connections catalog

Grouped by whether ATLAS can use it **today**.

### Tier 1 — Directly unblocks revenue (do these this week)

| What | Where to get it | Cost | Unblocks |
|---|---|---|---|
| **`COMPANY_POSTAL_ADDRESS`** (Evervibes env) | Your address, or a $10-15/mo virtual mailbox (Anytime Mailbox / PostScan) | ~$0-15/mo | **All outbound email, legally.** CAN-SPAM requires it. Wholesale intros, compliance outreach, surplus letters — all blocked. Cheapest, highest-value item on this list. |
| **Twin billing** | build.twin.so, add card | **$3.64** for all 52 traces | 68 surplus leads worth $2.23M, currently zero contactable |
| **Refresh `N8N_API_KEY`** | n8n.evervibes.org → Settings → API. Working value already sits in `evervibes/scripts/push-n8n-workflows.py` | free | `outreach` plugin — currently 401ing |
| **`GEMINI_API_KEY`** (confirm live + quota) | aistudio.google.com | free tier | Brain, leadscan lead-finding, **all image generation**. If one key is stale, three subsystems go dark. |

### Tier 2 — Makes existing capabilities actually good

| What | Where | Cost | Unblocks |
|---|---|---|---|
| **`ANTHROPIC_API_KEY`** | console.anthropic.com | ~$5 prepaid goes far | Coding ability (Part 2b), and a non-free fallback when Gemini's daily quota dies — which it did today |
| **`TAVILY_API_KEY`** | tavily.com | 1000 searches/mo free | `search` plugin — real research instead of scraping |
| **`SERPER_API_KEY`** | serper.dev | 2500 free | Google results; leadscan sourcing |
| **`GITHUB_TOKEN`** | github.com → Settings → Developer settings → PAT (repo scope) | free | `connectors` + `search` code search + orchestrator inbox |
| **`EMAIL_SMTP_HOST/USER/PASS`** | Gmail app password (2FA → App Passwords) | free | The `email` plugin can actually send. Right now every business's outreach ends at a draft. |

### Tier 3 — Businesses that need a connection you don't have yet

| Business | Missing connection | Notes |
|---|---|---|
| Social/Reels posting | `META_APP_ID` + `META_APP_SECRET` + `SOCIAL_LOGIN_CONFIG_ID` | developers.facebook.com. Instagram Graph API needs a Business/Creator account linked to a Facebook Page. **This is the only officially-sanctioned auto-post path** — worth the setup friction precisely because it doesn't risk a ban. |
| KDP publishing | *No API exists.* | Amazon has no KDP API. Playwright drives the wizard and stops before Publish by design. **This stays partly manual, permanently.** |
| Gig submission | Reddit OAuth (`script` app at reddit.com/prefs/apps) | Still your paused decision. Official OAuth is the only version that doesn't risk the account. |
| Compliance/leadscan | Nothing missing — 55 contactable leads waiting on the postal address only | |
| Wholesale | Nothing missing beyond postal address + AI quota | |
| Surplus | Twin billing + the legal read | |

### Tier 4 — Keys the UI asks for that nothing reads (fix or remove)

`STRIPE_RESTRICTED_KEY`, `RESEND_API_KEY`, `APIFY_API_KEY`, `POSTHOG_API_KEY`,
`PINTEREST_TOKEN`, `SLACK_TOKEN`.

Two of these are worth *making* real rather than deleting:
- **Resend** — 3000 emails/mo free, a far better sender than SMTP for cold outreach
  (proper DKIM/SPF, bounce handling, suppression lists). This is arguably the correct fix
  for the email-sending gap in Tier 2.
- **Stripe** — `cfo.pullReal` currently reads revenue through the Evervibes bridge. A
  restricted read-only key would let ATLAS read MRR directly and drop a dependency.

The other four should be deleted from the detector list until something consumes them.

---

## Part 5 — Plugins worth adding

| Plugin | Why | Depends on |
|---|---|---|
| **`reachability`** | Part 1, as a capability rather than only a test, so the UI can show it | nothing |
| **`sender`** | One place that actually delivers email (Resend primary, SMTP fallback), with suppression list + bounce handling. Today four businesses each end at a draft. | `RESEND_API_KEY` |
| **`engineering` (expanded)** | Part 2a — the execution arm | `ANTHROPIC_API_KEY` |
| **`motion`** | Ken Burns + music bed + optional generative clips; splits video *composition* out of `publishing`, which is getting large | nothing (3d/3e), Gemini (3f) |
| **`calendar`** | Nothing schedules anything. Follow-ups, publish times, and the surplus claim deadlines that actually have legal clocks on them. | Google Calendar OAuth |
| **`crm`** | Leads live in five different JSON files with five different status vocabularies. One contact record, one status machine, one dedupe. | nothing |

`crm` is the sleeper. Today's "133 leads marked contacted with nothing sent" bug is a direct
consequence of status being per-package folklore rather than a shared, tested state machine.

---

## Sequencing

**This week, in order:**

1. Set `COMPANY_POSTAL_ADDRESS` — 10 minutes, unblocks four businesses
2. Add Twin billing — $3.64, unblocks surplus
3. Refresh `N8N_API_KEY` — 5 minutes, value already in your repo
4. Bid the 10 real gigs — fastest actual cash, days not weeks
5. Build the reachability audit + dead-key test + `/api/capabilities` panel
6. Ken Burns + music bed (3d, 3e) — free, biggest visible quality jump

**Next:** `sender` plugin, Nano Banana Pro default, engineering execution arm.

**Still your call, not mine:** gig auto-submit mechanism, surplus legal read, whether to
reset the 133 lead statuses.

---

## One caution

The instinct to add capability is the right instinct, and ATLAS has a lot of it. But today's
evidence is that **ATLAS's constraint has never once been capability — it's been reachability.**
Four businesses were fully built and producing nothing. Every hour spent on the audit, the
capabilities panel, and the `sender` plugin converts existing built work into revenue. Every
hour spent on Veo 3 adds a seventh thing that might turn out to be wired to nothing.

Build Part 1 before Parts 2 and 3.
