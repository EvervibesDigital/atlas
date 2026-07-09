import type { Atlas } from "@atlas/core";

/**
 * Seed ATLAS with deep knowledge of Mat's real businesses and the full tool
 * stack. Populates the business registry, the AI Vault, and memory so ATLAS
 * knows where each build is and where it's headed. Idempotent by name — safe to
 * re-run (it skips what already exists).
 */

interface BizSeed {
  name: string;
  url?: string;
  goal: string;
  stage: "idea" | "building" | "running" | "improving";
  note: string;
}

const BUSINESSES: BizSeed[] = [
  {
    name: "EverVibes Digital",
    url: "https://evervibesdigital.com",
    goal: "Grow content + digital-product sales across the modular SaaS suite",
    stage: "running",
    note:
      "Main SaaS platform — Next.js 14 + Supabase, ~289 API routes, deployed on Vercel. A 14+ product suite (EverAds, EverContent, EverChat, EverInfluencer, EverAvatar, EverWholesale, EverLeads, EverSEO, EverMail, EverFunnels, Marketplace, Buyers Club). Content generation + auto-posting: Zernio auto-posts Reddit + LinkedIn text; video platforms (YouTube/IG/TikTok/Facebook) are still posted MANUALLY. Integrations: Stripe (payments), Resend (email), PostHog + Sentry, Upstash Redis, Cloudflare email worker, n8n workflows. STATUS: live/production, now run LEAN on a free stack after Mat cancelled paid tools (ElevenLabs, Creatomate, paid Zernio, paid Claude API). DIRECTION: grow content + digital-product revenue, move video posting from manual to automated, consolidate the modular products, and feed the AI-influencer content engine.",
  },
  {
    name: "EverVibes Wholesale",
    url: "https://n8n.evervibes.org",
    goal: "Close real-estate wholesale deals — fix supply, contactability, and activation",
    stage: "improving",
    note:
      "Real-estate wholesaling engine — wholesale-server.js (Node/Express :3002) + Supabase/JSON. Ollama (local LLM) grades deals; Vapi.io + Bland AI make AI voice calls; Brevo sends email blasts; DocuSeal handles e-signatures; n8n runs the workflows; county-records + YellowPages scraping generate leads. Custom n8n nodes: YellowPages cash-buyer scraper, website email enrichment, Twilio SMS deal alerts, Bland AI call-outcome tracking, Bird Dog verification calls. STATUS: STALLED at supply / contactability / activation, plus table fragmentation — 4 fixes were queued (tasks #97–100). DIRECTION: fix lead supply, buyer contactability and activation; tighten buyer matching + outreach; unify the fragmented tables.",
  },
  {
    name: "Amazon KDP",
    goal: "Automate research → write → publish → optimize for Kindle books at scale",
    stage: "building",
    note:
      "Kindle Direct Publishing arm — lives inside evervibes as lib/kdp plus the kdp-trends / kdp-trends-scan agents (scan for low-competition, high-demand book niches). Pipeline: niche research → concept → writing → cover/design → publish → optimize listings. STATUS: early/building — trend-scan tooling exists; the full write-to-publish loop is not yet automated. DIRECTION: automate research → draft → cover → publish, target niches surfaced by trend scans, and scale title volume.",
  },
  {
    name: "WaveRider Trader Bot",
    goal: "Autonomous crypto/stock paper-trading; graduate Phase 1 toward live",
    stage: "building",
    note:
      "Agentic crypto (and stock via Alpaca) paper-trading bot in its own repo waverider-bot/ (Python + Flask dashboard :5000). Loop: Watcher (price momentum + news) → Reasoner (Claude/Groq/Gemini) → RiskManager (stop-loss −3%, take-profit +5%, position sizing) → Broker → Reviewer (scores trades, updates playbook win-rates). Modes: offline (synthetic, free, rule-based), livepaper (real Coinbase prices, fake money), real (Alpaca paper/live + Claude). Data: Coinbase live prices, Alpaca, Etherscan whale-watching. Four competing strategy profiles: aggressive / balanced / conservative / scalper. STATUS: Phase 1 complete, runs offline with no keys; flip MODE=real for live Alpaca + Claude. DIRECTION: Phase 2 = deeper news feed + Reddit buzz signals; Phase 3 = cloud deployment.",
  },
  {
    name: "AI Avatar Influencer Army",
    url: "https://instagram.com/everspark.ai",
    goal: "Scale faceless → talking-avatar Instagram Reels across personas",
    stage: "building",
    note:
      "Faceless → talking-avatar Instagram Reels at scale, first persona @everspark.ai (niche: AI tools & side-hustle tips). Built INSIDE ATLAS: personas + creative (script via the Brain, Pollinations images, captions) + publishing (Instagram Reels validator, approval-gated, dry-run) + the orchestrator's nightly cycle (drafts a Reel). Free stack replacing cancelled paid tools: edge-tts (voice, replaces ElevenLabs), Pollinations (images), Remotion (render, replaces Creatomate), browser automation (posting, replaces Zernio). STATUS: pipeline built end-to-end but POSTS NOTHING yet (dry-run). Two hookups remain: (1) real MP4 encode (edge-tts + ffmpeg/Remotion), (2) live Instagram browser publisher with Mat's login. No-GPU laptop → talking avatars come later via free Colab/HF (SadTalker/Wav2Lip). DIRECTION: faceless first for volume, then a flagship talking-avatar persona; expand to more personas/niches once the loop performs.",
  },
];

interface ToolSeed {
  name: string;
  category: string;
  quality: number;
  free: boolean;
  approved?: boolean;
  url?: string;
  notes?: string;
}

const TOOLS: ToolSeed[] = [
  // LLMs
  { name: "Groq", category: "llm", quality: 5, free: true, notes: "fast free inference; bulk work" },
  { name: "Google Gemini", category: "llm", quality: 5, free: true },
  { name: "OpenRouter", category: "llm", quality: 5, free: true, notes: "many free models, one key" },
  { name: "Claude (Anthropic)", category: "llm", quality: 5, free: false, approved: true, notes: "Claude Code Pro — paid, approved" },
  { name: "Ollama", category: "llm-local", quality: 4, free: true, notes: "local/private, CPU on this laptop" },
  // Data / infra
  { name: "Supabase", category: "database", quality: 5, free: true },
  { name: "pgvector", category: "database", quality: 5, free: true },
  { name: "Upstash Redis", category: "cache", quality: 4, free: true },
  { name: "Vercel", category: "hosting", quality: 5, free: true },
  { name: "Cloudflare", category: "infra", quality: 5, free: true },
  { name: "Docker", category: "infra", quality: 5, free: true },
  { name: "n8n", category: "automation", quality: 5, free: true, notes: "self-hosted workflows" },
  { name: "GitHub Actions", category: "automation", quality: 5, free: true },
  // Posting
  { name: "Zernio", category: "posting", quality: 4, free: true, notes: "free tier: 2 accounts, unlimited posts" },
  { name: "Ayrshare", category: "posting", quality: 3, free: true },
  { name: "Upload-Post", category: "posting", quality: 3, free: true },
  { name: "Pinterest API", category: "posting", quality: 3, free: true },
  // Voice / audio
  { name: "edge-tts", category: "tts", quality: 4, free: true, notes: "free MS voices; replaces ElevenLabs" },
  { name: "ElevenLabs", category: "tts", quality: 5, free: false, approved: false, notes: "cancelled — not approved" },
  { name: "Piper", category: "tts", quality: 3, free: true },
  { name: "Whisper", category: "stt", quality: 5, free: true },
  // Video / image
  { name: "Remotion", category: "video", quality: 4, free: true, notes: "code video render; replaces Creatomate" },
  { name: "Creatomate", category: "video", quality: 4, free: false, approved: false, notes: "cancelled" },
  { name: "HeyGen", category: "avatar-video", quality: 5, free: false, approved: false },
  { name: "D-ID", category: "avatar-video", quality: 4, free: false, approved: false },
  { name: "SadTalker", category: "avatar-video", quality: 3, free: true, notes: "local talking-head, free" },
  { name: "Wav2Lip", category: "avatar-video", quality: 3, free: true },
  { name: "CapCut", category: "video-edit", quality: 4, free: true },
  { name: "Canva", category: "design", quality: 4, free: true },
  { name: "Pollinations", category: "images", quality: 4, free: true, notes: "free unlimited Flux, no key" },
  { name: "Pexels", category: "stock-images", quality: 4, free: true },
  { name: "Leonardo", category: "images", quality: 3, free: true },
  // Payments / email
  { name: "Stripe", category: "payments", quality: 5, free: true, notes: "pay-per-transaction" },
  { name: "Resend", category: "email", quality: 4, free: true },
  { name: "Brevo", category: "email", quality: 4, free: true },
  // Calls / signing
  { name: "Vapi.io", category: "voice-calls", quality: 4, free: false, approved: false },
  { name: "Bland AI", category: "voice-calls", quality: 4, free: false, approved: false },
  { name: "DocuSeal", category: "esign", quality: 4, free: true },
  // Trading
  { name: "Alpaca", category: "trading", quality: 5, free: true, notes: "paper + live" },
  { name: "Coinbase", category: "market-data", quality: 5, free: true },
  { name: "Etherscan", category: "onchain", quality: 4, free: true },
  // Observability / browser
  { name: "PostHog", category: "analytics", quality: 4, free: true },
  { name: "Sentry", category: "monitoring", quality: 4, free: true },
  { name: "Playwright", category: "browser-automation", quality: 5, free: true },
  { name: "Browserless", category: "browser-automation", quality: 4, free: true },
  // Other
  { name: "Shopify API", category: "ecommerce", quality: 4, free: false, approved: false },
  { name: "Pinokio", category: "local-ai", quality: 3, free: true },
  { name: "Obsidian", category: "notes", quality: 4, free: true },
];

const REFERENCE_NOTES: { kind: string; content: string }[] = [
  {
    kind: "reference",
    content:
      "Mat's connections/accounts ATLAS should know: GitHub (EvervibesDigital org), Vercel (hosts evervibesdigital.com), Supabase (Postgres+pgvector, project shgvmapfgjeigglbqfil), Cloudflare (email worker + tunnels), n8n (self-hosted at n8n.evervibes.org), Stripe, Resend, Brevo, Zernio, Vapi.io, Bland AI, DocuSeal, Alpaca, Coinbase, Etherscan, PostHog, Sentry, Upstash. LLM keys in vault: Groq, Gemini, OpenRouter, Anthropic. Add read-only tokens in the Connect tab (GitHub/Vercel/Supabase) to let ATLAS see repos/deploys/databases.",
  },
  {
    kind: "project",
    content:
      "Overall direction across Mat's ventures: run everything LEAN on free tools; ATLAS is the autonomous operating system that plans, learns, and acts with Mat's approval. Near-term priorities: (1) AI Avatar Influencer — wire the video encoder + live IG publisher to go from dry-run to real posts; (2) Wholesale — unblock supply/contactability/activation and unify tables; (3) Digital — automate video posting; (4) KDP — automate research→publish; (5) WaveRider — Phase 2 news/Reddit signals then cloud deploy. Guardrails: nothing irreversible without approval, snapshot before code changes.",
  },
];

export interface SeedResult {
  businesses: number;
  tools: number;
  notes: number;
}

export async function seedKnowledge(atlas: Atlas): Promise<SeedResult> {
  const existingBiz = (await atlas.invoke("business", { op: "listBusinesses" })) as Array<{ name: string }>;
  const haveBiz = new Set(existingBiz.map((b) => b.name.toLowerCase()));

  let businesses = 0;
  let notes = 0;
  for (const b of BUSINESSES) {
    if (haveBiz.has(b.name.toLowerCase())) continue;
    await atlas.invoke("business", { op: "add", business: { name: b.name, url: b.url, goal: b.goal, stage: b.stage } });
    await atlas.invoke("memory", { op: "remember", input: { kind: "business", content: `${b.name}: ${b.note}`.slice(0, 3000), metadata: { business: b.name } } });
    businesses++;
    notes++;
  }

  const existingTools = (await atlas.invoke("toolvault", { op: "list" })) as Array<{ name: string }>;
  const haveTools = new Set(existingTools.map((t) => t.name.toLowerCase()));
  let tools = 0;
  for (const t of TOOLS) {
    if (haveTools.has(t.name.toLowerCase())) continue;
    await atlas.invoke("toolvault", { op: "add", tool: t });
    tools++;
  }

  // Only add the reference notes on the first seed (when businesses were added)
  // to avoid duplicates on re-run.
  if (businesses > 0) {
    for (const n of REFERENCE_NOTES) {
      await atlas.invoke("memory", { op: "remember", input: { kind: n.kind, content: n.content } });
      notes++;
    }
  }

  return { businesses, tools, notes };
}
