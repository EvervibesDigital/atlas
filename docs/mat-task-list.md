# Mat's task list — verified live 2026-08-02

Every number below was read off the running VPS today, not from memory. Where I
could not verify something (the vault is locked, so credential-dependent state
is invisible to me), it is marked **UNVERIFIED** rather than asserted.

Control panel: **http://72.62.168.207:4317**

---

## TIER 0 — Do these first, they gate everything else

### 0.1 — Unlock the vault and open the new Health tab
**Time: 2 minutes.** Everything else on this list is easier once you can see
this. The Health tab (new today) lists every service as `ready` / `needs key` /
`partly wired` / `unreachable`, and names the exact missing key per service.

As of the last local run the counts were **5 ready, 11 needs-key, 11 partial,
9 unreachable** — but that was computed against a test key set, so *your* real
numbers will differ. This tab is the answer to "what's actually working", and it
replaces every guess in this document about credentials.

**Do this before 0.2 and Tier 2 — it may resolve several of them instantly.**

### 0.2 — Set `COMPANY_POSTAL_ADDRESS` in the Evervibes environment
**Time: 10 minutes. Still the highest value/effort ratio on the list.**

- Where: Vercel → Evervibes project → Settings → Environment Variables
- Value: a real physical mailing address. If you don't want your home address on
  every email, a virtual mailbox runs $10–15/mo (Anytime Mailbox, PostScan Mail,
  iPostal1). A PO box works for CAN-SPAM as long as it's registered with USPS.
- Redeploy after saving — Vercel env vars don't apply to the running deployment.

**Blocks, today:** every wholesale intro email, all compliance outreach, and the
surplus letters. US commercial email is legally required to carry a physical
postal address (CAN-SPAM, 15 U.S.C. §7704). The `send-intro` API already returns
a warning when it's unset — that warning was confirmed firing live.

---

## TIER 1 — Finished work sitting unsent (this is where the money already is)

### 1.1 — 31 Instagram Reel approvals are queued and waiting
**Verified live: `data/approvals.json` holds 94 records — 31 pending, all of
them `"Post Reel to Instagram (@everspark.ai)"`, risk 2, created 2026-08-01 and
2026-08-02.**

This is the Reel-publish dead end from yesterday now working: renders finish,
and each one requests your approval instead of vanishing. They're accumulating
because nobody has answered them.

- Where: control panel → **Approvals** tab
- Each shows the caption + hashtags before you approve

**⚠️ Check this first:** approving a Reel only posts if the Meta credentials are
present (`META_APP_ID`, `META_APP_SECRET`, `SOCIAL_TOKEN_KEY`,
`SOCIAL_LOGIN_CONFIG_ID`). **UNVERIFIED** — I can't read the vault. Look at
`social` on the Health tab. If it says `needs key`, approving all 31 will
silently accomplish nothing. See 2.3.

Also worth knowing: these were rendered *before* today's Ken Burns motion and
music-bed work. Re-rendering would produce noticeably better video than what's
in the queue right now.

### 1.2 — 28 approved gig bids have never been submitted
**Verified live: `data/gigs.json` holds 168 gigs — 28 `approved`, 133
`rejected`, 7 `new`. All 28 approved gigs have `submitted: null`.**

You reviewed and approved 28 bids and not one has been sent to a client. This is
the single largest pool of ready-to-earn work in the system, and it is 100%
blocked on you because you deliberately paused auto-submit (correctly — see 3.1).

- **Action:** open each gig's Reddit URL, paste the drafted bid, post it as a
  comment or DM under your own account.
- Realistically: 28 × ~4 minutes ≈ **2 hours** for the full backlog.
- Gig work is the fastest path to actual cash (days, not weeks), and it's the
  only business where ATLAS can also *do* the work once won — winning one
  auto-generates a work package and a paste-ready Claude Code prompt.

### 1.3 — Review the 7 new gigs
Newest include `[Hiring] Looking for a Software Developer for building small…`
and a `[HIRING] MACHINE LEARNING ENGINEER at State Farm`, all from r/jobbit.

- Where: control panel → **Gig Finder** tab
- Approve or reject; approving drafts a bid.

### 1.4 — Send 3 compliance emails (not 7 — see below)
**Verified live: 153 leads. 25 `new`, 128 `contacted`. Of the 25 new, only 7
have an email address. Of the 128 marked contacted, ZERO have an email stored.**

Scoring runs **100 = no issues found**, so a *low* score is a *good* prospect.
Ranked by what you can actually sell them:

| Score | Issues | Business | Email | Verdict |
|---|---|---|---|---|
| 40 | 3 | Law Offices of David A. Black | david@dbphoenixcriminallawyer.com | **Best prospect** |
| 59 | 3 | Myers Law Offices, LLC | amyers@myerslaw.org | **Worth sending** |
| 73 | 2 | Moseley Collins Law | incoming@moseleycollins.com | **Worth sending** |
| 85 | 1 | Blake Law Firm | Lisa@AccidentLawyersArizona.com | Thin — one finding |
| 98 | 1 | Yee Law Group, Inc. | info@mylawyersllp.com | Thin |
| 98 | 1 | Brinkley Law | info@brinkleylawllc.com | Thin |
| 100 | 0 | Zazueta Law, PLLC | admin@zazuetalawfirm.com | **Cannot send** |

Zazueta has a clean site. `renderComplianceOutreach` will **throw** rather than
send them a pitch with nothing behind it — that refusal is deliberate and
correct, not a bug to work around.

Blocked on 0.2 (postal address). After that: Businesses tab → draft outreach.

---

## TIER 2 — Credentials, roughly in value order

### 2.1 — Add billing to Twin — **$3.64**
- Where: https://build.twin.so → billing → add card
- Unlocks: skip-tracing 52 surplus leads at $0.070/matched property
- Without it, surplus holds leads worth $2.23M and **zero** contactable people
- **UNVERIFIED** since 2026-07-26 — confirm the 68/52 figures still hold once
  the key works (control panel → Businesses → Surplus)

### 2.2 — Refresh `N8N_API_KEY` in the ATLAS vault
- The stored key returns **HTTP 401** (last verified 2026-08-01)
- A working key is already hardcoded as `N8N_KEY` in
  `evervibes/scripts/push-n8n-workflows.py` — copy it from there
- Or mint a fresh one: https://n8n.evervibes.org → Settings → API
- Where to paste: control panel → **Keys & Logins** tab
- Unlocks: the `outreach` plugin (the bridge to your compliance + wholesale n8n
  workflows). Base `https://n8n.evervibes.org/api/v1`, header `X-N8N-API-KEY` —
  ATLAS already sends the right header, only the value is stale.

### 2.3 — Meta / Instagram credentials (gates all 31 queued Reels)
Four values: `META_APP_ID`, `META_APP_SECRET`, `SOCIAL_LOGIN_CONFIG_ID`,
`SOCIAL_TOKEN_KEY`.

- Where: https://developers.facebook.com → your app → Settings → Basic
- Prerequisite: the Instagram account must be a **Business or Creator** account
  **linked to a Facebook Page**. A personal IG account cannot use the Graph API.
- This is the *only officially sanctioned* auto-post path. Worth the setup
  friction precisely because it can't get the account banned, unlike browser
  automation.

### 2.4 — Confirm `GEMINI_API_KEY` is live and has quota
- Where: https://aistudio.google.com → Get API key (free tier)
- **Three subsystems die together if this key is stale**: the Brain's primary
  provider, leadscan's lead finding, and *all* image generation
- Two of three redundant cycle runners were disabled 2026-08-01, so quota should
  have recovered on the daily reset — worth confirming rather than assuming

### 2.5 — `ANTHROPIC_API_KEY` (~$5 prepaid goes a long way)
- Where: https://console.anthropic.com → API keys
- Two jobs: a real fallback when Gemini's free quota dies mid-day (it did), and
  materially better multi-file code editing than the free providers

### 2.6 — Free keys worth 5 minutes each
| Key | Where | Free tier | Unlocks |
|---|---|---|---|
| `TAVILY_API_KEY` | tavily.com | 1,000 searches/mo | Real research in `search` |
| `SERPER_API_KEY` | serper.dev | 2,500 searches | Google results, lead sourcing |
| `GITHUB_TOKEN` | github.com → Settings → Developer settings → PAT, `repo` scope | free | `connectors` + code search + orchestrator inbox |

### 2.7 — Email sending (pick ONE)
Right now every business ends at a draft — nothing can actually send.
- **Recommended: Resend** (resend.com), 3,000 emails/mo free, proper DKIM/SPF,
  bounce handling, suppression lists. **Note:** nothing reads `RESEND_API_KEY`
  yet — it needs the `sender` plugin built first. Get the key and tell me.
- **Available today: SMTP.** `EMAIL_SMTP_HOST` / `EMAIL_USER` / `EMAIL_PASS`.
  For Gmail you need an App Password (Google Account → Security → 2-Step
  Verification → App Passwords), *not* your login password. The `email` plugin
  reads these now — but note `email.send` is itself still unreachable (in the
  41-op backlog), so this needs a small wiring job too.

---

## TIER 3 — Decisions only you can make

### 3.1 — Gig auto-submit: pick a mechanism
Still paused at your call, and I won't build it without your decision. Options:

1. **Reddit official OAuth** — https://reddit.com/prefs/apps, create a `script`
   app. Sanctioned, no ban risk, needs your credentials. **My recommendation.**
2. **Browser automation** — violates Reddit ToS, real risk of losing the account
   your name is attached to.
3. **Prepare-and-open** — ATLAS opens the tab with the bid on your clipboard,
   you click submit. Zero risk, keeps 1.2 a manual 2-hour job.

Your words were *"it is my name on it not atlas"* — option 3 honours that
completely, option 1 honours it with an audit trail. I'd do 3 now and 1 later.

### 3.2 — Legal read on surplus outreach — **before the first letter**
Florida regulates surplus-funds recovery (F.S. 45.033 and related). The fee
percentage and solicitation timing need your attorney partner's sign-off. Letters
are written and tested in `packages/surplus/src/outreach-templates.ts`, with the
fee % as a *required input* specifically so there is something concrete to approve.

**This is the one item where being wrong harms real people who just lost their
homes.** On avoiding attorneys: you can't in surplus — they file the claim, and
non-attorney filing is unauthorized practice of law in most states. Restructuring
as *flat-fee marketing services to an attorney* (not a %-of-recovery contract
with homeowners) moves the legal weight onto them. Note attorneys generally
cannot fee-split with non-lawyers, so flat fee is the viable shape.

### 3.3 — The 128 "contacted" leads — revised recommendation
Earlier I suggested resetting these to `new`. **New data changes that: all 128
have no email address stored at all.** Resetting them produces 128 leads you
still can't contact.

The useful order is: **re-run contact extraction over them first**, then reset
whichever gain an email. Say the word and I'll wire that as a one-shot job.

---

## TIER 4 — Needs your eyes because I can't see it

### 4.1 — KDP: publish the 30 books — **UNVERIFIED**
Last known (2026-08-01): 18 `generated`, 12 `downloaded`, **0 published**. I
can't re-check without the Evervibes bridge credentials.
- Where: control panel → **KDP** tab for current status
- Amazon has **no KDP API**. `uploadToAmazon` (Playwright) drives the wizard and
  stops before the Publish click by design, and needs your logged-in Amazon
  browser session. **This step is permanently partly manual.**
- A week of finished inventory earning nothing.

### 4.2 — Resume the surplus scraper schedule in Twin — **UNVERIFIED**
Last known: PAUSED, no new surplus leads since 2026-07-16. Even after 2.1 the
pipeline won't refill until this is running again. Check at build.twin.so.

---

## What's on me, not you

- 41 unreachable ops remain in the frozen backlog (down from 64)
- 9 services still can't be triggered at all: analytics, automation, experiments,
  legacy, opportunity, research, setup, simulation, and `codebase`'s heal/generate
- `sender` plugin (needs 2.7 decided first)
- Re-render the 31 queued Reels with the new motion + music, if you want them
  regenerated rather than posted as-is

---

## If you only do three things

1. **`COMPANY_POSTAL_ADDRESS`** — 10 minutes, unblocks three businesses
2. **Submit 10 of the 28 approved gig bids** — ~40 minutes, fastest real cash
3. **Twin billing, $3.64** — turns 52 dead surplus leads into contactable people
