# AI Influencer Social Platform (`@atlas/social`) — Design

## Goal

Give ATLAS a real, always-on pipeline that takes what Media Factory creates and gets it live on real Instagram and Facebook accounts — reliably, at the scale of up to 10 influencer personas each posting multiple times a day — with Mat reviewing once a day in his existing Morning Brief, not per post. Also close the loop the other direction: read comments/DMs on those accounts and reply, auto-sending the confident ones and asking Mat about the rest.

This is not just "add posting." An audit of the current system (done as part of this design) found the *supply side* (Media Factory's content generation) has a hard throughput ceiling far below what 10 creators need, the AI providers it depends on are already hitting quota limits at today's single-persona scale, and video rendering is capped at 30 seconds inline in a way that will silently degrade to image-only under real load. This spec fixes those alongside building the new posting/reply pipeline — building the demand side onto a supply side that can't feed it would just move the bottleneck, not remove it.

## Scope

**In this build:**
- New `@atlas/social` package: Meta Graph API client, OAuth account connection, posting, comment/DM polling, AI-drafted replies.
- Media Factory throughput fix: per-creator daily targets, multiple items produced per cycle (not one globally).
- Async video rendering (background job queue, no more 30s inline cap).
- Multi-provider quota/backoff strategy for image/video/caption generation.
- Brief integration that groups by creator, not one row per post.
- Per-account health monitoring (token expiry, connection status) via the existing urgent-alert email.

**Explicitly out of scope (not this build):**
- Platforms other than Instagram + Facebook (TikTok/Twitter/LinkedIn/etc. — separate future sub-project if wanted).
- OnlyFans/Fanvue (Playwright-based, unrelated to this Meta API work, already scoped separately in AtlasBridge).
- Autonomous account creation or CAPTCHA/bot-detection bypass — every account is one Mat has personally logged into and authorized (standing ATLAS-wide boundary).
- Real-time webhooks — polling on ATLAS's existing hourly cycle, consistent with how every other business in ATLAS already works.
- Full analytics/growth dashboards beyond basic per-account/per-post status.
- Content storage retention/archival policy — current usage (6MB of 96GB on the VPS) isn't urgent; revisit if disk usage becomes a real concern.

## Architecture Overview

A new package `@atlas/social` (service `"social"`), same plugin shape as `@atlas/kdp`/`@atlas/wholesale`: `createSocialPlugin()`, `ctx.provide("social", ...)`, secrets via `ctx.secret()`. Runs on the VPS inside ATLAS's existing process — no new deploy, no new server. Registers into the existing orchestrator cycle and Brief, the same way KDP and wholesale already do.

Secrets used: `META_APP_ID`, `META_APP_SECRET` (already in the vault). Per-account access tokens are stored encrypted at rest in a new local store (`data/social-accounts.json`, AES-256-GCM, same encryption approach already proven in AtlasBridge's `crypto.ts` — ported in, not depended on as a live service since AtlasBridge itself isn't deployed).

## Data Model

```ts
interface SocialAccount {
  id: string;                    // uuid
  platform: "instagram" | "facebook";
  personaLabel: string;          // e.g. "Aria Vance" — matches the Media Factory creator name
  pageId: string;                // Facebook Page ID (Instagram posts route through its linked Page)
  igBusinessAccountId?: string;  // set for platform "instagram"
  accessTokenEnc: string;        // AES-256-GCM encrypted long-lived Page token
  tokenObtainedAt: string;       // ISO date — used to compute expiry warnings
  connectedAt: string;
  status: "connected" | "token_expired" | "error";
}

interface SocialPost {
  id: string;
  contentItemId: string;         // FK to Media Factory's content_items
  accountId: string;             // FK to SocialAccount
  mediaType: "image" | "video" | "reel";
  caption: string;
  mediaPath: string;             // local file path (image or rendered video)
  status: "ready" | "approved" | "publishing" | "published" | "failed";
  scheduledFor?: string;         // staggered publish time, set on approval
  publishedAt?: string;
  livePostUrl?: string;
  error?: string;
  createdAt: string;
}

interface InboxItem {              // comments + DMs, same shape across both
  id: string;
  accountId: string;
  externalId: string;              // Meta's comment/message id (dedupe key)
  kind: "comment" | "dm";
  fromUsername: string;
  text: string;
  draftReply: string;
  confidence: number;              // 0-100
  status: "auto_replied" | "pending_approval" | "approved" | "rejected";
  repliedAt?: string;
  createdAt: string;
}
```

All three persist to simple JSON files under `dataDir`, matching the existing `LeadRegistry`/`GigRegistry`/`ProposalRegistry` pattern already used throughout ATLAS — no new database dependency.

## Connecting an Account

1. Mat adds the Instagram/Facebook account as a Tester on the Meta Developer app (Development Mode — no App Review needed since every account is his own; I'll walk him through this per-account when we get there).
2. ATLAS generates a one-time OAuth URL (`social.getConnectUrl`) requesting scopes: `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `pages_messaging`, `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`.
3. Mat opens it, logs in, grants access. Meta redirects to a callback route (`GET /api/social/oauth/callback`) which exchanges the code for a long-lived Page token (Meta's token-exchange endpoint, ~60-day validity), looks up the linked Instagram Business Account ID if present, and writes one encrypted `SocialAccount` record.
4. Confirmation shown in the control panel; the account now appears in Brief's account-health section.

## Media Factory Throughput Fix (Supply Side)

**Current state (confirmed by reading the code):** `mediaFactory.autoCycle` produces exactly one output per invocation — either a fresh calendar for one creator, or one scripted item — and is called once per hourly cycle. That's a hard ceiling of ~24 items/day system-wide, regardless of creator count.

**Fix:** `autoCycle` takes a `maxItems` parameter (default: `min(creatorsNeedingWork.length, 10)`) and loops, producing one item per creator-with-room-in-today's-target per call, instead of one item total. A new `DAILY_POST_TARGET` per creator (default 2, stored on the creator record, Mat-adjustable per persona) caps how much gets produced for that creator per day — pure function `itemsNeededToday(creator, itemsProducedToday, target)` decides how many more to make, unit tested the same way `shouldPauseGeneration` was for KDP's backlog cap.

At 10 creators × target 2/day, this produces up to 20 items/day system-wide, spread across every creator each cycle rather than starving 9 of them while one gets fed.

## Video Rendering: Async Job Queue

**Current state (confirmed live in logs this session):** rendering is a synchronous `Promise.race` capped at 30 seconds inside the orchestrator cycle — real renders (TTS + image fetch + ffmpeg) routinely exceed that under any real load, silently falling back to image-only.

**Fix:** a new `data/video-jobs.json`-backed queue (`VideoRenderJob: { id, contentItemId, status: "queued"|"rendering"|"done"|"failed", requestedAt, completedAt, resultPath }`). `mediaFactory.autoCycle` enqueues a job instead of rendering inline. A separate, lightweight interval (`setInterval`, every 2 minutes, independent of the hourly business cycle so a slow render never blocks anything else) picks up ONE queued job, renders it with `MontageRenderer` (no artificial timeout beyond a generous 5-minute outer safety bound), and marks it done/failed. `social.publish` only posts a video-type item once its job is `done`; if still rendering when Mat approves, the post stays `"approved"` and fires as soon as the render completes rather than failing.

## Provider / Quota Strategy

**Current state (confirmed live in logs this session):** Gemini image/text calls are already returning HTTP 429 (quota exceeded), and the Hugging Face fallback models are failing outright (`fetch failed`) — at today's single-persona scale. This will only get worse at 10x volume.

**Fix:**
1. Every generation call (image, video script, caption, reply draft) goes through the existing Brain provider-priority chain (Gemini → Groq → HuggingFace → Ollama → stub) — already built, just needs to actually be exercised correctly. Confirm the chain advances past a 429 to the next provider rather than surfacing the failure (audit the current `brain` adapter's retry logic as the first implementation task here — this may already work correctly and just need verification, or may need a fix).
2. A per-provider daily call budget (soft cap, e.g. Gemini image calls capped below its actual quota) so ATLAS backs off to the next provider in the chain *before* hitting a 429, not after.
3. Quota exhaustion on the top provider surfaces as one line in the daily digest ("Gemini image quota hit at 2pm, ran on Groq for the rest of the day") — visible, never silent.
4. If every provider in the chain is exhausted, generation for that item is skipped for the cycle (not retried in a tight loop burning more quota) and picked up next cycle.

## Posting Flow (Demand Side)

1. Media Factory content clears its existing "review" status, unchanged.
2. A new `fromSocial()` Brief source groups ready posts **by creator**, not one row per post: `"Aria Vance — 3 posts ready"`, expandable to see each one's caption/thumbnail. Tier: `bulk` (matches the earlier decision — batch-approved like emails, never silently posted).
3. Mat approves the batch (or an individual creator's batch) from the Brief, same one-tap flow as today.
4. On approval, `social.publish` doesn't fire every post at once — it assigns each a staggered `scheduledFor` time spread across the next several hours (avoids posting 8 things in the same second, which reads as automated and risks Meta's own abuse heuristics even through the official API). A lightweight scheduler (same 2-minute interval as the video job queue) fires any post whose `scheduledFor` has passed.
5. Publishing calls Meta's real Graph API: `POST /{ig-user-id}/media` (create container) → `POST /{ig-user-id}/media_publish` for Instagram; `POST /{page-id}/photos|videos|feed` for Facebook, depending on `mediaType`. Result (live URL or error) is recorded on the `SocialPost` row and surfaced back through the same confirmation-note pattern already used for wholesale/seller-outreach.

## Comments & DMs

1. Once per hourly cycle, `social.pollInbox` iterates every connected account and fetches new comments (`GET /{ig-media-id}/comments`) and DMs (`GET /{page-id}/conversations`) since that account's last poll timestamp (persisted per-account, same dedupe-by-timestamp approach as the urgent-alerts feature just shipped).
2. Each new item gets a drafted reply via the Brain (same provider chain as above) plus a confidence score (0-100; starting heuristic: short, clearly positive, non-question messages score high; anything with a question mark, negative sentiment signal, or unusual length scores low — refined once real data exists).
3. Confidence ≥ 90 (configurable): auto-send via Graph API, logged, never shown to Mat unless he opens the inbox view.
4. Below 90: queued as an individual **ask**-tier Brief item (never batched — this is closer to a phone call than an email) with the incoming message and drafted reply shown; Mat approves, edits, or rejects.

## Meta API Rate Limits

The Graph API enforces per-app and per-user call quotas. The staggered-posting scheduler above already spreads load naturally; additionally every Graph API call goes through a thin rate-limit-aware wrapper that reads Meta's own `X-Business-Use-Case-Usage` response header and backs off (delays the next call) as usage approaches the limit, rather than firing until a 4xx comes back.

## Account Health Monitoring

A new Brief section (or extension of the existing account-status idea) lists all connected accounts with status (`connected`/`token_expired`/`error`) and days until token expiry. Once a token has fewer than 7 days left, it's included in the next urgent-alert email (the "ATLAS needs your input" mechanism shipped earlier this session) so reconnecting happens before something silently breaks, not after.

## Error Handling

Every Graph API call's failure is caught, recorded on the relevant `SocialPost`/`InboxItem` row with the real error text, and surfaced — never swallowed into a bare `catch {}`. This directly applies the lesson from today's `pending_actions` schema bug (six call sites silently failing for weeks because their errors were caught and discarded).

## Testing Strategy

Pure logic — `itemsNeededToday`, confidence scoring, staggered-time assignment, the rate-limit backoff calculation, OAuth URL construction, Graph API request/response shaping — gets unit tests with mocked `fetch`, matching the existing `@atlas/kdp` convention (injectable `fetcher` option). Integration points (the actual plugin `ctx.provide` handlers) get tests with a fake fetcher, same pattern as `packages/kdp/test/kdp.test.ts`. No test hits the real Meta API.
