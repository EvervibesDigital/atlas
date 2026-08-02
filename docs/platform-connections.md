# Platform connections — what can actually be automated

Verified 2026-08-02 against current vendor documentation, not memory.

## The short version

**All three marketplaces block the action, not the discovery.** Amazon, Upwork
and Fiverr each let you (or ATLAS) *find* work programmatically to different
degrees, and none of them let you *submit* it. The final click is human on every
one of them — by vendor design, not by our limitation.

That is a strategic fact worth internalising rather than fighting: it means the
automation ceiling for marketplace work is "everything up to the submit button",
and effort spent trying to cross that line buys account risk instead of revenue.

---

## Amazon KDP

| | |
|---|---|
| Official API | **None.** Amazon has never shipped a KDP API. |
| What exists | `uploadToAmazon` (Playwright) drives the real browser wizard |
| Blocked at | The **Publish** button, deliberately |
| Needs from Mat | A logged-in Amazon session in the browser ATLAS drives |

The Playwright flow fills metadata and uploads the manuscript and cover, then
stops. Automating the final Publish click would put a real Amazon account — and
the royalties attached to it — behind an unattended script. Not worth it for the
seconds it saves.

**Status: as automated as it can legitimately get.** The remaining work is 30
Publish clicks.

---

## Upwork

| | |
|---|---|
| Official API | **Yes** — GraphQL at `api.upwork.com/graphql`, OAuth 2.0 |
| Can it search jobs? | **Yes** |
| Can it submit a proposal? | **No — the mutation does not exist in the schema** |
| Approval | Apply at upwork.com/developer/keys/apply, reply within ~2 weeks |

This is the important one. Upwork's public API supports job search, profile
lookup, contract and messaging reads, and webhooks. It has **no mutation for
submitting a proposal, applying to a job, or spending Connects.** You cannot
auto-bid through the official API, full stop.

Third-party "auto-apply" tools exist. They work by driving the browser session,
which is what the API deliberately does not permit — the same account-risk
trade Mat already declined for Reddit.

**Worth doing anyway:** the read half is genuinely valuable. Gig Finder currently
sources only Reddit (`r/forhire`, `r/jobbit`, `r/n8n`, `r/zapier`) via search
queries. Upwork job search would be a far richer, better-structured feed than
scraping Reddit titles — real budgets, real skill tags, real client history.

**Action:** apply for the key. It costs a form and two weeks of waiting, and it
upgrades gig *sourcing* substantially. Just don't expect it to bid.

- Key request: https://www.upwork.com/developer/keys/apply
- Choose **OAuth 2.0**, describe the use as internal job-sourcing for your own
  freelancing. Rejections are usually incomplete account data or a vague
  description.
- After approval: Client ID + Secret in the API Center. Access tokens refresh
  biweekly.

---

## Fiverr

| | |
|---|---|
| Official seller API | **None.** No public API for managing gigs or orders. |
| What exists | Third-party scrapers (Apify et al.) for market research only |
| Unofficial API | Community project, currently blocked by Fiverr's Cloudflare |

Fiverr is inverted from the others anyway: buyers come to you, so there is no
"bid" to automate. The work is gig listing quality and ranking, which is a
copywriting and positioning problem, not an integration one.

**Status: fully manual, and that's fine.** The only automatable slice is market
research — scraping competitor gigs for pricing and positioning — which is a
"maybe later", not a blocker.

---

## Everything else, current status

| Platform | State | Note |
|---|---|---|
| **Hostinger email** | ✅ **Connected and verified sending** | Test email delivered 2026-08-02 |
| **Instagram / Meta** | ✅ All four keys present | 31 Reel approvals waiting on clicks |
| **Twin AI** | ✅ Key present | ⚠️ Needs **billing** ($3.64) to run |
| **Google Sheets** | ✅ Connected | Surplus leads |
| **n8n** | ✅ Key present | Was 401ing — retest via Businesses tab |
| **GitHub / Vercel / Supabase** | ✅ Tokens present | `connectors` |
| **Tavily + Serper** | ✅ Both present | `search` fully credentialed |
| **Gemini** | ⚠️ Key valid, **quota exhausted (429)** | Daily reset |
| **Anthropic** | ⚠️ Key valid, **credit balance too low** | ~$5 prepaid fixes it |
| **Reddit** | ❌ Not connected | Needed only if auto-submit is built |
| **Stripe** | Keys present, **nothing reads them** | Deliberate — see KEY_SPECS |

---

## What this means for the plan

The gig business was chosen because it's the one where ATLAS can do the *work*,
not just the marketing. That reasoning is unaffected — winning a gig still
auto-generates a work package and a paste-ready prompt, and the deliverable is
still software ATLAS can build.

What changes is the honest ceiling on the *acquisition* half: find, draft,
rank, and queue can all be automated. Submitting cannot, on any of the three
platforms, without taking on account risk that Mat has already correctly
declined once.

So the highest-value remaining automation is **prepare-and-open**: ATLAS puts
the bid on the clipboard and opens the posting, Mat reads and clicks. That gets
a 4-minute manual bid down to about 30 seconds without touching a ToS.
