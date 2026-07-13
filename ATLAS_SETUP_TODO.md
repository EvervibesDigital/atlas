# ATLAS — Owner's Guide (verified honest, 2026-07-12)

Every item below was tested against the real running system. No aspirational claims.

## 🚀 Start ATLAS

Double-click **ATLAS.bat on your Desktop**. It starts Ollama + the server and opens
the control panel. First cold start takes ~30-60s; after that it's instant.

---

## 🔴 STEP 1 — Fix your keys (10 min, unblocks everything)

Verified live on 2026-07-12: **your Gemini key and Groq key are both INVALID**
(the API rejects them), and you have no HuggingFace or Tavily key. Until fixed,
ATLAS runs 100% on local Llama 3.2 — private and unlimited, but slow (~10-25s/reply).

| Key name | Get it here (all free, no credit card) | Must look like | Unlocks |
|---|---|---|---|
| `GEMINI_API_KEY` | https://aistudio.google.com/apikey | `AIzaSy…` (39 chars) | Fast smart brain (primary) |
| `GROQ_API_KEY` | https://console.groq.com/keys | `gsk_…` | Fastest replies (70B in ~2s) |
| `HUGGINGFACE_API_KEY` | https://huggingface.co/settings/tokens | `hf_…` | 45K models + real semantic memory |
| `TAVILY_API_KEY` | https://app.tavily.com | `tvly-…` | Web search: nightly tool-hunting actually works |
| `GITHUB_TOKEN` | https://github.com/settings/tokens (read-only scopes) | `ghp_…` | Message ATLAS from your phone via GitHub issues |

**How to save:** unlock ATLAS → API Keys tab → paste into either box → save.
Then click **"🌙 Enable overnight runs"** so the nightly cycle can use them.
Then send one chat message — the reply badge must say `gemini` (not `ollama`).

## 🟠 STEP 2 — Put the fixed code in the cloud (5 min)

Your GitHub Actions scheduler (3 cycles/day) EXISTS and is committed — but the
repo on GitHub is **16+ commits behind** this machine, so the cloud runs old,
partly-broken code (including a Gemini bug fixed today).

1. Ask Claude to commit + push (or: `git add -A && git commit && git push` in C:\Users\matbr\atlas)
2. On GitHub → repo → Settings → Secrets → Actions: add `GEMINI_API_KEY` (your new valid key)
3. Actions tab → "atlas-daily" → "Run workflow" once to confirm it goes green

## 🟡 STEP 3 — Optional connections

- **Newsletters**: ATLAS reads the 9 sites daily without subscribing. To ALSO get
  them in email, subscribe yourself (Learn tab has the checklist; signup forms are
  owner-gated by design).
- **Email (EMAIL_USER/EMAIL_PASS)**: already in your vault; the email plugin is
  present but its reader is not wired to a real mailbox yet — treat as not working.
- **Inbox from the road**: set `ATLAS_INBOX_REPO=EvervibesDigital/atlas` in .env
  (needs GITHUB_TOKEN). Then a GitHub issue titled with an instruction reaches the
  nightly cycle.

---

## ✅ What ATLAS truly does today (verified)

- Chat with real memory: recalls relevant past lessons, saves every exchange
- Brain routing: Gemini → Groq → HuggingFace → Ollama, honest scoring, offline floor
- Daily cycle (button or 3x/day in cloud once pushed): drafts a Reel, council review,
  queues publishing FOR YOUR APPROVAL (posts nothing by itself), compliance check,
  studies one of your business sites, reads 3 newsletters into memory (rotating),
  recalls adopted directives + past lessons before deciding
- Proposals: when something keeps failing, it proposes a fix; **Adopt** stores it as
  a standing directive that chat + cycles recall
- Self-improve (Grow tab): reads its own code, drafts a change on the free local
  brain, and can only apply it after an automatic typecheck — bad drafts auto-roll back
- Skills + Forge: invent prompt-skills instantly; draft real plugin code gated
  behind typecheck + your approval
- Smart key detection, encrypted vault, approval gates on all real-world actions

## ⚠️ Honest weak spots (and the fill)

1. **No valid cloud keys** → everything slow. Fill: Step 1. (5 min, biggest win)
2. **Cloud scheduler runs stale code** → Fill: Step 2 push.
3. **Publishing is draft+approve only** — ATLAS cannot actually post to Instagram/
   TikTok/etc. Fill: connect a posting service with an API (your Zernio flow, or
   Buffer/Publer free tier) — ask Claude to wire it when you pick one.
4. **No real revenue actions unattended.** ATLAS left alone for weeks will: learn
   daily, study your businesses, draft content, build approval queues, and file
   proposals — but money-making actions (posting, outreach, listings) are
   approval-gated on purpose. "Weeks alone" = a full pipeline waiting for your
   15-minute approval pass, not silent sales. Closing that gap safely = wiring
   specific posting/outreach integrations + auto-approve rules per channel.
5. **Email agent unwired** (reader stub). Fill: pick provider (Gmail app password)
   and ask Claude to wire IMAP read-only.
6. **Search/tool-hunting dead without Tavily key.** Fill: Step 1.
7. **Local test suite**: 11 brain tests fail ONLY because Ollama is running on this
   machine (environmental, pre-existing). Fill: pin tests to a dead port env var.
