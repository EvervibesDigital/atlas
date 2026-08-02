import { createServer as httpCreateServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { randomUUID, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import pg from "pg";
import type { Atlas } from "@atlas/core";
import type { ProviderAdapter } from "@atlas/brain";
import type { BrowserDriver } from "@atlas/browser";
import { buildAtlas, checkReadiness } from "@atlas/app";
import { Vault } from "@atlas/vault";
import { TaskQueue } from "../../orchestrator/src/task-queue";
import { LiveBrowserPublisher } from "@atlas/publishing";
import { SessionStore } from "./sessions";
import { PAGE, MOBILE_BRIEF_PAGE, MOBILE_BRIEF_EXPIRED } from "./html";
import { getSelfImprovementTarget, generateSelfImprovementDraft, applySelfImprovementPatch, type SelfImprovementRequest, type SelfImprovementDraft } from "./self-improve";
import { checkFabricatedActionClaim, FABRICATION_CORRECTION } from "./chat-safety";
import { alertKey, findNewUrgentItems, buildUrgentAlertEmail, type AlertableItem } from "./urgent-alerts";
import { loadSourceFiles, capabilityReport, type CapabilityStatus } from "./reachability";

const KNOWN_PROVIDERS = ["GROQ_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"];
const CRED_PREFIX = "cred:";

// Self-improvement drafts pending Mat's review (in-memory store for this session)
const selfImprovementDrafts = new Map<string, SelfImprovementDraft>();

/**
 * Parse pasted key text into name/value pairs. Accepts many formats on separate
 * lines: `KEY=value`, `export KEY=value`, `KEY: value`, `KEY value`, optional
 * quotes; ignores blank lines and #/// comments.
 */
/** Resolve `rel` under `baseDir`, refusing anything that escapes it (no
 * `../` traversal). Returns null if the result would land outside baseDir. */
export function resolvePathSafe(baseDir: string, rel: string): string | null {
  const base = resolve(baseDir);
  const full = resolve(base, rel);
  const r = relative(base, full);
  if (r.startsWith("..") || isAbsolute(r)) return null;
  return full;
}

export function parseKeyLines(text: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z][A-Za-z0-9_.-]*)\s*(=|:|\s)\s*(.+)$/);
    if (!m) continue;
    const name = m[1]!;
    // A bare whitespace separator only counts for KEY-style (SCREAMING_SNAKE)
    // names, so prose lines aren't mistaken for keys.
    if (/^\s$/.test(m[2]!) && !/^[A-Z][A-Z0-9_]*$/.test(name)) continue;
    // Don't mistake a pasted URL ("https://…") for a key named "http"/"https":
    // the "://" makes the scheme look like NAME:value. Skip these.
    if (/^https?$/i.test(name) && m[3]!.startsWith("//")) continue;
    const value = m[3]!.trim().replace(/^["']|["']$/g, "").trim();
    if (value) out.push({ name, value });
  }
  return out;
}

/**
 * Detect known API keys/tokens in free text by their shape, so ATLAS can store
 * them securely from a chat paste WITHOUT the values ever reaching the LLM.
 */
interface KeySpec {
  re: RegExp;
  name: string;
  label: string;
  category: string;
  free: boolean;
  approved?: boolean;
  sensitive?: boolean;
  /**
   * Set ONLY when no capability reads this key yet. Asking Mat for a key ATLAS
   * cannot use is the same "built but unreachable" failure as an op with no
   * caller — it just wastes his time instead of his compute. The reachability
   * test requires either a real `ctx.secret("NAME")`/`process.env.NAME` reader
   * or an explanation here, so a dead detector cannot be added silently.
   */
  unusedReason?: string;
}
export const KEY_SPECS: KeySpec[] = [
  { re: /sk-ant-[A-Za-z0-9_-]{20,}/g, name: "ANTHROPIC_API_KEY", label: "Anthropic", category: "llm", free: false, approved: true },
  { re: /sk-or-v1-[A-Za-z0-9]{20,}/g, name: "OPENROUTER_API_KEY", label: "OpenRouter", category: "llm", free: true },
  { re: /gsk_[A-Za-z0-9]{30,}/g, name: "GROQ_API_KEY", label: "Groq", category: "llm", free: true },
  { re: /AIza[A-Za-z0-9_-]{30,}/g, name: "GEMINI_API_KEY", label: "Google Gemini", category: "llm", free: true },
  { re: /hf_[A-Za-z0-9]{30,}/g, name: "HUGGINGFACE_API_KEY", label: "HuggingFace", category: "llm", free: true },
  { re: /sbp_[a-f0-9]{40}/g, name: "SUPABASE_TOKEN", label: "Supabase", category: "database", free: true },
  { re: /(?:ghp|github_pat)_[A-Za-z0-9_]{20,}/g, name: "GITHUB_TOKEN", label: "GitHub", category: "dev", free: true },
  { re: /(?:vck|vcp)_[A-Za-z0-9]{20,}/g, name: "VERCEL_TOKEN", label: "Vercel", category: "hosting", free: true },
  { re: /rk_live_[A-Za-z0-9]{20,}/g, name: "STRIPE_RESTRICTED_KEY", label: "Stripe (live)", category: "payments", free: true, sensitive: true, unusedReason: "Not read yet. Intended for cfo.pullReal to read MRR straight from Stripe instead of through the evervibes bridge." },
  { re: /pk_live_[A-Za-z0-9]{20,}/g, name: "STRIPE_PUBLISHABLE_KEY", label: "Stripe (publishable)", category: "payments", free: true, unusedReason: "Not read yet. Publishable keys are client-side only; kept so a pasted key blob is fully recognised rather than half-parsed." },
  { re: /re_[A-Za-z0-9_]{16,}/g, name: "RESEND_API_KEY", label: "Resend", category: "email", free: true },
  { re: /tvly-[A-Za-z0-9-]{16,}/g, name: "TAVILY_API_KEY", label: "Tavily", category: "search", free: true },
  { re: /apify_api_[A-Za-z0-9]{20,}/g, name: "APIFY_API_KEY", label: "Apify", category: "scraping", free: true, unusedReason: "Not read yet. Scraping runs on plain fetch today; kept as a recognised name so a pasted blob is not silently mangled." },
  { re: /ph[xc]_[A-Za-z0-9]{20,}/g, name: "POSTHOG_API_KEY", label: "PostHog", category: "analytics", free: true, unusedReason: "Not read yet. No product analytics are wired; ATLAS tracks its own metrics in data/metrics.json." },
  { re: /pina_[A-Za-z0-9]{30,}/g, name: "PINTEREST_TOKEN", label: "Pinterest", category: "posting", free: true, unusedReason: "Not read yet. Publishing supports Instagram via the Meta Graph API only." },
  { re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, name: "SLACK_TOKEN", label: "Slack", category: "messaging", free: true, unusedReason: "Not read yet. Notifications go to the control panel and the Brief, not to Slack." },
  // A full Postgres connection string (Supabase, Neon, Railway, etc.) — the
  // whole URL is the value, not a short prefixed token like the others above.
  { re: /postgres(?:ql)?:\/\/[^\s"'<>]+/g, name: "DATABASE_URL", label: "Postgres database", category: "database", free: true, sensitive: true },
];

export interface DetectedSecret {
  name: string;
  label: string;
  value: string;
  category: string;
  free: boolean;
  approved: boolean;
  sensitive: boolean;
}

export function detectSecrets(text: string): DetectedSecret[] {
  const out: DetectedSecret[] = [];
  const seenValue = new Set<string>();
  const seenName = new Set<string>();
  for (const s of KEY_SPECS) {
    const matches = text.match(s.re);
    if (!matches) continue;
    for (const v of matches) {
      if (seenValue.has(v) || seenName.has(s.name)) continue; // one value per env name
      seenValue.add(v);
      seenName.add(s.name);
      out.push({ name: s.name, label: s.label, value: v, category: s.category, free: s.free, approved: s.approved ?? false, sensitive: s.sensitive ?? false });
    }
  }
  return out;
}

/** Replace secret values with a safe placeholder so they never reach the LLM/logs. */
export function redactSecrets(text: string, secrets: DetectedSecret[]): string {
  let out = text;
  for (const s of secrets) out = out.split(s.value).join(`[saved:${s.name}]`);
  return out;
}

/**
 * Catch the common connection-string mistakes BEFORE saving, so the vault
 * never ends up holding a value that will only fail later, deep inside
 * whatever plugin tries to use it (e.g. media-factory's raw "Invalid URL").
 * Only checks things that are wrong regardless of network access — actual
 * connectivity can only be proven by using the credential for real.
 */
export function validateSecretValue(name: string, value: string): string | null {
  const looksLikeDbUrl = name === "DATABASE_URL" || /^postgres(ql)?:\/\//i.test(value.trim());
  if (!looksLikeDbUrl) return null;

  if (value.includes("[") || value.includes("]")) {
    return `${name}: still contains a "[...]" placeholder (like "[YOUR-PASSWORD]") — replace it with the real value before saving, brackets included.`;
  }
  try {
    new URL(value.trim());
  } catch {
    return `${name}: doesn't parse as a valid URL. Common causes: a password with special characters (@, #, %, etc.) that needs URL-encoding, extra spaces, or stray text left over from copy-pasting. Easiest fix: generate a fresh alphanumeric-only password from the provider's dashboard and copy the connection string again.`;
  }
  return null;
}

/**
 * FRUGAL layer #1 — answer trivial messages (greetings/acks) with a canned
 * reply and ZERO LLM calls, so rate-limited models aren't spent on "hi".
 */
export function trivialReply(message: string): string | null {
  const m = message.trim().toLowerCase();
  if (/^(hi+|hey+|hello|yo|sup|howdy)[.! ]*$/.test(m)) return "Hey Matt — ready. What are we working on?";
  if (/^(thanks|thank you|thx|ty|nice|cool|great|awesome|perfect|love it)[.! ]*$/.test(m)) return "Anytime. What's next?";
  if (/^(ok|okay|k|kk|got it|sounds good|yes|yep|yeah|no|nope)[.! ]*$/.test(m)) return "👍";
  if (/^(status|health|are you (there|up|online|ready))[?. ]*$/.test(m)) return "Online and running on the smart brain. Ask me anything, or check the Status tab.";
  return null;
}

/**
 * Chat command router — lets the chat DO things by mapping natural language to
 * a real ATLAS service call. Deterministic (fast, free, reliable, frugal); if
 * nothing matches, the message falls through to a normal LLM reply.
 */
export interface ChatIntent {
  kind: string;
  service: string;
  payload: unknown;
  intro: string;
}

export function routeChatIntent(message: string): ChatIntent | null {
  const m = message.trim();
  const low = m.toLowerCase();
  let x: RegExpMatchArray | null;

  // "free apis for X"  OR  "free X apis/tools"
  let freeTopic: string | null = null;
  if ((x = low.match(/free\s+(?:ai\s+)?(?:apis?|tools?)\s+(?:for|to|about)\s+(.{2,})/))) freeTopic = x[1]!;
  else if ((x = low.match(/free\s+(.{2,}?)\s+(?:apis?|tools?)\b/))) freeTopic = x[1]!;
  if (freeTopic) {
    const topic = freeTopic.replace(/[?.!]+$/, "").trim();
    return { kind: "freeApis", service: "search", payload: { op: "freeApis", topic }, intro: `🆓 Free tools for "${topic}":` };
  }
  if (/\b(scout|find|search|look).{0,20}(github|repos?)\b/.test(low) || /\bimprove atlas\b/.test(low) || /\brepos? (that|to).{0,30}(improve|better)\b/.test(low)) {
    const q = m.replace(/.*\b(github|repos?)\b/i, "").trim() || "autonomous AI agent framework OR MCP server OR LLM tools";
    return { kind: "scout", service: "search", payload: { op: "scout", query: q, max: 8 }, intro: `🔎 GitHub repos worth a look:` };
  }
  if ((x = low.match(/(?:find|what'?s|whats|get)\s+(?:the\s+)?(?:website|site|url)\s+(?:for|of)\s+(.{2,})/))) {
    return { kind: "findSite", service: "search", payload: { op: "findSite", name: x[1]!.trim() }, intro: `🌐 Best match:` };
  }
  if ((x = low.match(/^(?:search|look up|google|web search)\s+(?:for\s+)?(.{2,})/))) {
    return { kind: "search", service: "search", payload: { op: "web", query: x[1]!.trim() }, intro: `🔎 Results:` };
  }
  if (/\b(run|do)\b.{0,20}\b(cycle|daily|today'?s work|the day|my day)\b/.test(low)) {
    return { kind: "cycle", service: "orchestrator", payload: { op: "runDailyCycle", videoRef: null }, intro: `▶ Running today's cycle…` };
  }
  if ((x = m.match(/^(?:red[- ]?team|stress[- ]?test|poke holes(?:\s+in)?)[:\s]+(.{4,})/i))) {
    return { kind: "redteam", service: "redteam", payload: { op: "challenge", idea: x[1]!.trim() }, intro: `🔴 Red Team:` };
  }
  if ((x = m.match(/^(?:learn|study|read)\s+(https?:\/\/\S+)/i))) {
    return { kind: "learn", service: "web", payload: { op: "learn", url: x[1]! }, intro: `🎓 Studied it:` };
  }
  if (/\b(brainstorm|curiosity|new ideas|give me ideas|opportunit)/.test(low)) {
    return { kind: "curiosity", service: "curiosity", payload: { op: "ideas" }, intro: `🧠 Ideas:` };
  }
  if (/\b(ceo brief|business brief|how are (my|the) business|state of the business)/.test(low)) {
    return { kind: "brief", service: "business", payload: { op: "brief" }, intro: `📊 Brief:` };
  }
  if (/\b(check|read|any).{0,12}(email|inbox|mail)\b/.test(low)) {
    return { kind: "email", service: "email", payload: { op: "check", limit: 8 }, intro: `📧 Inbox:` };
  }
  if (/\bconnect\b.{0,20}\b(instagram|facebook|social)\b/.test(low) || /\b(social|instagram|facebook)\b.{0,20}\bconnect\b/.test(low)) {
    return { kind: "socialConnect", service: "social", payload: { op: "getConnectUrl" }, intro: `🔗 Connect an Instagram/Facebook account:` };
  }
  if (/\bsurplus\b/.test(low) && /\b(status|agents?|funds?|leads?|how|check|show)\b/.test(low)) {
    return { kind: "surplus", service: "surplus", payload: { op: "listAgents" }, intro: `💰 Surplus Funds Platform:` };
  }
  if (/\b(morning brief|today'?s brief|what'?s (pending|waiting)|what needs my approval)\b/.test(low)) {
    return { kind: "morningBrief", service: "brief", payload: { op: "today" }, intro: `☀️ This morning:` };
  }
  if (/\b(n8n|outreach)\b/.test(low) && /\b(status|workflows?|running|check|show)\b/.test(low)) {
    return { kind: "outreach", service: "outreach", payload: { op: "listWorkflows" }, intro: `🔌 n8n workflows:` };
  }
  if (/\bwholesale\b/.test(low) && /\b(status|deals?|pending|check|show|actions?)\b/.test(low)) {
    return { kind: "wholesale", service: "wholesale", payload: { op: "list" }, intro: `🏠 Wholesale pending actions:` };
  }
  if (/\b(leads?|compliance)\b/.test(low) && /\b(status|new|pending|check|show|scan(ned)?)\b/.test(low)) {
    return { kind: "leadscan", service: "leadscan", payload: { op: "list", status: "new" }, intro: `🔍 New compliance leads:` };
  }
  if (/\b(vitals|how are you doing|how'?s it going|self.?check|are you (stuck|stalled|idle|growing|learning)|health check|are we making progress)\b/.test(low)) {
    return { kind: "vitals", service: "vitals", payload: { op: "check" }, intro: `🩺 ATLAS vitals:` };
  }
  if (/\b(revenue|mrr|how much (money|are we making)|are we (making money|profitable))\b/.test(low)) {
    return { kind: "revenue", service: "cfo", payload: { op: "pullReal" }, intro: `💵 Real revenue:` };
  }
  return null;
}

/** Format an agent result into a readable chat reply. */
export function formatIntentResult(kind: string, result: unknown): string {
  const r = result as Record<string, unknown>;
  const list = (r.results ?? r.candidates ?? []) as Array<{ title?: string; url?: string }>;
  if (kind === "search" || kind === "freeApis" || kind === "scout") return list.length ? list.map((x) => `• ${x.title ?? ""} — ${x.url ?? ""}`).join("\n") : "(no results — is the search key set?)";
  if (kind === "findSite") return r.best ? `→ ${(r.best as { title: string; url: string }).title} — ${(r.best as { url: string }).url}` : "(couldn't find it)";
  if (kind === "redteam") return String(r.critique ?? "");
  if (kind === "curiosity") return String(r.ideas ?? "");
  if (kind === "learn") return String(r.notes ?? "");
  if (kind === "brief") return `${String(r.summary ?? "")}\n${((r.recommendations as Array<{ priority: string; action: string }>) ?? []).slice(0, 5).map((x) => `• [${x.priority}] ${x.action}`).join("\n")}`;
  if (kind === "email") {
    const msgs = (r.messages as Array<{ subject: string; from: string; links: string[] }>) ?? [];
    return msgs.length ? msgs.map((x) => `✉ ${x.subject} — ${x.from}${x.links[0] ? `\n   link: ${x.links[0]}` : ""}`).join("\n") : "(inbox empty or not configured)";
  }
  if (kind === "socialConnect") {
    return `${String(r.url ?? "")}\n\nOpen it, log in, and grant access — Meta will show "Almost done" once it's ready for ATLAS to finish connecting.`;
  }
  if (kind === "morningBrief") {
    const items = (r.items as Array<{ source: string; title: string; detail?: string }>) ?? [];
    return items.length ? items.map((i) => `• [${i.source}] ${i.title}${i.detail ? ` — ${i.detail}` : ""}`).join("\n") : "(nothing waiting on you — all clear)";
  }
  if (kind === "outreach") {
    const workflows = (r.workflows as Array<{ name: string; active: boolean }>) ?? [];
    if (!workflows.length) return "(no n8n workflows found — is N8N_API_KEY set in the Keys tab?)";
    return workflows.map((w) => `• ${w.active ? "🟢" : "⚪"} ${w.name}`).join("\n");
  }
  if (kind === "surplus") {
    const agents = (r.agents as Array<{ name: string; latest_run_status?: string; last_activity_at?: string }>) ?? [];
    if (!agents.length) return "(no surplus agents found — is TWIN_API_KEY set in the Keys tab?)";
    return agents.map((a) => `• ${a.name}${a.latest_run_status ? ` — ${a.latest_run_status}` : ""}${a.last_activity_at ? ` (${a.last_activity_at.slice(0, 10)})` : ""}`).join("\n");
  }
  if (kind === "wholesale") {
    const actions = (r.actions as Array<{ action_type: string; roi_score: number; target_summary: string | null }>) ?? [];
    if (!actions.length) return "(nothing pending — or KDP_CRON_SECRET isn't set in the Keys tab)";
    return actions.map((a) => `• ${a.action_type}${a.target_summary ? ` — ${a.target_summary}` : ""}${a.roi_score ? ` (~$${a.roi_score.toLocaleString()})` : ""}`).join("\n");
  }
  if (kind === "leadscan") {
    const leads = (Array.isArray(result) ? result : []) as Array<{ businessName: string; website: string; scan?: { overallScore: number } }>;
    if (!leads.length) return "(no new leads — is GEMINI_API_KEY set, and has 'find leads' been run recently?)";
    return leads.map((l) => `• ${l.businessName} — ${l.website}${l.scan ? ` (score ${l.scan.overallScore}/100)` : ""}`).join("\n");
  }
  if (kind === "revenue") {
    const rev = r as { mrr?: number; one_time_this_month?: number; breakdown?: Record<string, number> };
    if (typeof rev.mrr !== "number") return "(no real revenue bridge configured — set KDP_CRON_SECRET in the Keys tab, same value as evervibes' CRON_SECRET)";
    const b = rev.breakdown ?? {};
    return [
      `$${rev.mrr.toFixed(2)}/mo real MRR, $${(rev.one_time_this_month ?? 0).toFixed(2)} one-time revenue this month.`,
      `• SaaS: $${(b.saas_mrr ?? 0).toFixed(2)}/mo across ${b.saas_active_subscribers ?? 0} active subscriber(s)`,
      `• Wholesale investor subs: $${(b.wholesale_investor_mrr ?? 0).toFixed(2)}/mo across ${b.wholesale_paying_investors ?? 0} payer(s)`,
      `• Module purchases this month: $${(b.module_purchases_this_month ?? 0).toFixed(2)}`,
      `• Deal unlocks this month: $${(b.deal_unlocks_this_month ?? 0).toFixed(2)}`,
    ].join("\n");
  }
  if (kind === "vitals") {
    const v = r as {
      output?: { pending: number; stalled: number; oldestAgeDays: number; byTier: Record<string, number> };
      growth?: { knowledge: number; knowledgeDelta: number | null };
      learning?: { outcomes: number; categories: number; avgSuccessRate: number | null };
      revenue?: { mrr: number | null; mrrDelta: number | null };
      flags?: string[];
      healthy?: boolean;
    };
    const o = v.output, g = v.growth, l = v.learning, rv = v.revenue;
    const lines: string[] = [];
    if (o) lines.push(`📤 Output: ${o.pending} waiting (${o.byTier.ask ?? 0} need you, ${o.byTier.bulk ?? 0} batchable, ${o.byTier.auto ?? 0} auto)${o.stalled > 0 ? `, ${o.stalled} stalled >${o.oldestAgeDays}d` : ""}.`);
    if (g) lines.push(`📈 Growth: ${g.knowledge} things learned${g.knowledgeDelta !== null ? ` (${g.knowledgeDelta >= 0 ? "+" : ""}${g.knowledgeDelta} since last check)` : ""}.`);
    if (l) lines.push(`🧠 Learning: ${l.outcomes} outcome(s) recorded across ${l.categories} area(s)${l.avgSuccessRate !== null ? `, ${Math.round(l.avgSuccessRate * 100)}% success` : ""}.`);
    if (rv) lines.push(rv.mrr !== null ? `💵 Revenue: $${rv.mrr.toFixed(2)}/mo real MRR${rv.mrrDelta !== null ? ` (${rv.mrrDelta >= 0 ? "+" : ""}$${rv.mrrDelta.toFixed(2)} since last check)` : ""}.` : `💵 Revenue: no real revenue bridge configured yet.`);
    const flags = v.flags ?? [];
    lines.push(flags.length ? `\n⚠️ I noticed:\n${flags.map((f) => `• ${f}`).join("\n")}` : `\n✅ Everything's flowing — nothing stuck.`);
    return lines.join("\n");
  }
  if (kind === "cycle") {
    const rep = r as {
      topic?: string;
      reel?: { hook?: string };
      pendingApprovals?: unknown[];
      cycleHealth?: { succeeded: number; failed: number; failures: Array<{ step: string; error: string }> };
      healReport?: { healed: number; attempted: number; total: number };
    };
    const health = rep.cycleHealth;
    const healthLine = health
      ? health.failed > 0
        ? `\n⚠️ ${health.failed} of ${health.succeeded + health.failed} steps failed: ${health.failures.map((f) => f.step).join(", ")}.`
        : `\n✅ All ${health.succeeded} steps succeeded.`
      : "";
    const heal = rep.healReport;
    const healLine = heal && heal.attempted > 0 ? `\n🩹 Self-heal: fixed ${heal.healed}/${heal.attempted} code errors found this cycle.` : "";
    return `Done. Topic: ${rep.topic}. Drafted hook: "${rep.reel?.hook ?? ""}". ${rep.pendingApprovals?.length ?? 0} item(s) awaiting your approval.${healthLine}${healLine}`;
  }
  return JSON.stringify(r).slice(0, 800);
}

/**
 * FRUGAL layer #2 — size the request so the Brain Router picks a cheap/fast
 * model for simple asks and the strong model only for hard ones.
 */
export function chatNeeds(message: string): Record<string, number> {
  const words = message.trim().split(/\s+/).filter(Boolean).length;
  const hard = /\b(strateg|analy|plan|why|compare|design|architect|legal|forecast|evaluate|pros and cons|should i|build|improve|red[- ]?team)\b/i.test(message);
  if (words <= 6 && !hard) return { reasoning: 0.3, speed: 0.8, cost: 1 };
  if (hard || words > 40) return { reasoning: 0.85, creativity: 0.5, cost: 1 };
  return { reasoning: 0.6, creativity: 0.4, cost: 1 };
}

/** Parse pasted text into a de-duped list of http(s) URLs (bare domains get https). */
export function parseUrls(text: string): string[] {
  const urls: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (/^https?:\/\//i.test(line)) urls.push(line.split(/\s+/)[0]!);
    else if (/^[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(line)) urls.push("https://" + line);
  }
  return [...new Set(urls)];
}

export interface ControlPanelOptions {
  vaultFile?: string;
  dataDir?: string;
  /** Override the brain's provider list — tests use this to force deterministic offline-stub behavior. */
  brainAdapters?: ProviderAdapter[];
  /** Enable the orchestrator's automatic self-healing step (default true). Tests set this false. */
  healEnabled?: boolean;
  /** Driver for the Actions department — see AtlasOptions.actionsDriver in packages/app/src/build.ts for the full explanation. Defaults to SimulatedDriver unless ATLAS_REAL_ACTIONS=true. */
  actionsDriver?: BrowserDriver;
  /** Driver for KDP's uploadToAmazon op — see AtlasOptions.kdpDriver in packages/app/src/build.ts for the full explanation. Defaults to SimulatedDriver unless ATLAS_REAL_KDP_UPLOAD=true. */
  kdpDriver?: BrowserDriver;
  /** Where the KDP Playwright session persists (default "data/kdp-session.json"). */
  kdpSessionFile?: string;
  /** Where "Enable overnight runs" writes provider keys (default ./.env). */
  envFile?: string;
  /** Failed unlocks before a temporary lockout (default 5). */
  maxUnlockFails?: number;
  /** Lockout duration in ms after too many failed unlocks (default 15 min). */
  lockoutMs?: number;
}

export interface ControlPanel {
  server: Server;
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

/**
 * ATLAS Control Panel — a localhost-only web UI + JSON API. All secrets live in
 * an encrypted Vault, unlocked with a master password. Secret/credential values
 * are never returned to the browser; only names/usernames are. Bind to
 * 127.0.0.1 so it is never reachable off the machine.
 */
export function createControlPanel(opts: ControlPanelOptions = {}): ControlPanel {
  const vaultFile = opts.vaultFile ?? "./data/vault.enc.json";
  const dataDir = opts.dataDir ?? "./data";
  const mediaFactoryImagesDir = `${dataDir}/media-factory-images`;
  const envFile = opts.envFile ?? "./.env";
  const maxUnlockFails = opts.maxUnlockFails ?? 5;
  const lockoutMs = opts.lockoutMs ?? 15 * 60 * 1000;
  const vault = new Vault(vaultFile);
  const sessions = new SessionStore(`${dataDir}/chats.json`);
  const queue = new TaskQueue();
  let token: string | null = null;
  let atlas: Atlas | null = null;
  let failedUnlocks = 0;
  let lockedUntil = 0;
  let automationIntervalId: NodeJS.Timeout | null = null;
  let lastAutomationRun: string | null = null;
  let isAutomationRunning = false;
  let isAutomationEnabled = false;
  const automationStateFile = `${dataDir}/automation.json`;
  const briefStateFile = `${dataDir}/brief-digest.json`;
  const urgentAlertStateFile = `${dataDir}/urgent-alerts.json`;
  const videoJobsFile = `${dataDir}/video-jobs.json`;
  const socialPostsFile = `${dataDir}/social-posts.json`;
  const socialInboxFile = `${dataDir}/social-inbox.json`;

  // ── Morning-brief magic links ─────────────────────────────────────────
  // The digest email carries ONE signed link; tapping it opens a phone page
  // that can read the brief and approve/reject — scoped to the brief only,
  // never the whole control panel. HMAC-signed with a persisted secret so
  // links survive restarts but can't be forged. Publicly reachable route,
  // so the signature IS the auth.
  let linkSecretCache: string | null = null;
  async function linkSecret(): Promise<string> {
    if (linkSecretCache) return linkSecretCache;
    if (process.env.ATLAS_LINK_SECRET) return (linkSecretCache = process.env.ATLAS_LINK_SECRET);
    const f = `${dataDir}/link-secret`;
    try {
      const s = (await readFile(f, "utf8")).trim();
      if (s) return (linkSecretCache = s);
    } catch { /* first run */ }
    linkSecretCache = randomBytes(32).toString("hex");
    try { await writeFile(f, linkSecretCache); } catch { /* best-effort persist */ }
    return linkSecretCache;
  }
  async function signBriefToken(ttlMs = 24 * 60 * 60 * 1000): Promise<string> {
    const exp = Date.now() + ttlMs;
    const sig = createHmac("sha256", await linkSecret()).update(`brief:${exp}`).digest("hex");
    return `${exp}.${sig}`;
  }
  async function verifyBriefToken(raw: string | undefined): Promise<boolean> {
    if (!raw) return false;
    const [expStr, sig] = String(raw).split(".");
    if (!expStr || !sig) return false;
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || exp < Date.now()) return false;
    const expected = createHmac("sha256", await linkSecret()).update(`brief:${exp}`).digest("hex");
    try {
      const a = Buffer.from(sig, "hex"), b = Buffer.from(expected, "hex");
      return a.length === b.length && timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  /** Separate from the once-daily digest: after every hourly cycle, immediately
   * email Mat about any NEW "ask"-tier item (money/phone/a specific person —
   * see @atlas/brief's tier docs) instead of making him wait for the morning
   * email to find out ATLAS needs a call. Dedupes against everything already
   * alerted on (persisted to disk), so one stuck item doesn't re-email every
   * hour it sits unapproved. Best-effort: never throws, never blocks the
   * cycle that calls it. Runs even if the cycle itself failed — ask-tier
   * items can already be sitting there from sources unrelated to whatever
   * just failed. */
  async function checkUrgentFindings(): Promise<void> {
    if (!vault.unlocked) return;
    try {
      const a = await ensureAtlas();
      const brief = (await a.invoke("brief", { op: "today" })) as { items: AlertableItem[] };
      const items = brief.items ?? [];

      let alerted: string[] = [];
      try {
        alerted = JSON.parse(await readFile(urgentAlertStateFile, "utf8")) as string[];
      } catch { /* first run */ }

      const fresh = findNewUrgentItems(items, new Set(alerted));
      if (fresh.length === 0) return;

      const { subject, body } = buildUrgentAlertEmail(fresh);
      await a.invoke("email", { op: "ownerNotify", subject, body });
      console.log(`[URGENT ALERT] Emailed Mat about ${fresh.length} new ask-tier item(s).`);

      // Cap at the most recent 500 keys so this can't grow unbounded across
      // months of hourly cycles — dedupe is all this list is for.
      const updated = [...new Set([...alerted, ...fresh.map(alertKey)])].slice(-500);
      await writeFile(urgentAlertStateFile, JSON.stringify(updated), "utf8");
    } catch (err) {
      console.error("[URGENT ALERT] check failed:", (err as Error).message);
    }
  }

  /** Picks up ONE queued video-render job every 2 minutes, independent of
   * the hourly business cycle so a slow render (TTS + image fetch + ffmpeg
   * can legitimately take minutes) never blocks anything else, and a cycle
   * never again has to guess-and-timeout at 30s. */
  async function processOneVideoJob(): Promise<void> {
    if (!vault.unlocked) return;
    try {
      const raw = await readFile(videoJobsFile, "utf8").catch(() => "[]");
      const jobs = JSON.parse(raw) as import("@atlas/publishing").VideoRenderJob[];
      const { nextQueuedJob, markDone, markFailed, requestPublishForFinishedJob } = await import("@atlas/publishing");
      const job = nextQueuedJob(jobs);
      if (!job) return;

      const rendering = jobs.map((j) => (j.id === job.id ? { ...j, status: "rendering" as const } : j));
      await writeFile(videoJobsFile, JSON.stringify(rendering), "utf8");

      const a = await ensureAtlas();
      try {
        const result = (await Promise.race([
          a.invoke("publishing", { op: "renderQueuedJob", spec: job.spec }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("render exceeded 5 minute safety bound")), 5 * 60_000)),
        ])) as { videoPath: string };
        const done = markDone(rendering, job.id, result.videoPath);
        await writeFile(videoJobsFile, JSON.stringify(done), "utf8");
        console.log(`[VIDEO QUEUE] Job ${job.id} rendered: ${result.videoPath}`);

        const finishedJob = done.find((j) => j.id === job.id)!;
        try {
          const publishResult = await requestPublishForFinishedJob(finishedJob, (input) => a.invoke("publishing", { op: "publish", input }));
          if (publishResult) console.log(`[VIDEO QUEUE] Job ${job.id} requested publish approval:`, JSON.stringify(publishResult));
        } catch (err) {
          console.error(`[VIDEO QUEUE] Job ${job.id} finished but auto-publish-request failed:`, (err as Error).message);
        }
      } catch (err) {
        await writeFile(videoJobsFile, JSON.stringify(markFailed(rendering, job.id, (err as Error).message)), "utf8");
        console.error(`[VIDEO QUEUE] Job ${job.id} failed:`, (err as Error).message);
      }
    } catch (err) {
      console.error("[VIDEO QUEUE] worker tick failed:", (err as Error).message);
    }
  }

  setInterval(() => void processOneVideoJob(), 2 * 60 * 1000);

  /** Fires any social posts whose scheduled time has arrived — same 2-minute
   * interval pattern as the video job worker, independent of the hourly
   * business cycle. */
  async function publishDueSocialPosts(): Promise<void> {
    if (!vault.unlocked) return;
    try {
      const a = await ensureAtlas();
      const result = (await a.invoke("social", { op: "publishDuePosts" })) as { published: number; failed: number };
      if (result.published > 0 || result.failed > 0) {
        console.log(`[SOCIAL] Published ${result.published}, failed ${result.failed}.`);
      }
    } catch (err) {
      console.error("[SOCIAL] publishDuePosts tick failed:", (err as Error).message);
    }
  }

  setInterval(() => void publishDueSocialPosts(), 2 * 60 * 1000);

  async function runAutomationCycleOnce(): Promise<void> {
    if (isAutomationRunning) return;
    try {
      isAutomationRunning = true;
      lastAutomationRun = new Date().toISOString();
      console.log(`[AUTOMATION] Running automated hourly cycle at ${lastAutomationRun}...`);
      const a = await ensureAtlas();
      await a.invoke("orchestrator", { op: "runDailyCycle", videoRef: null });
      console.log("[AUTOMATION] Automated hourly cycle complete.");
    } catch (err) {
      console.error("[AUTOMATION] Automated cycle failed:", err);
    } finally {
      await checkUrgentFindings();
      isAutomationRunning = false;
    }
  }

  function startAutomationLoop(): void {
    if (automationIntervalId) return;
    console.log("[AUTOMATION] Hourly automation loop started.");
    automationIntervalId = setInterval(runAutomationCycleOnce, 60 * 60 * 1000);
    setImmediate(runAutomationCycleOnce); // first run right away for feedback
  }

  async function persistAutomationState(): Promise<void> {
    try {
      await writeFile(automationStateFile, JSON.stringify({ enabled: isAutomationEnabled }), "utf8");
    } catch { /* persistence is best-effort */ }
  }

  // Survive restarts: if automation was ON before the process died (deploy,
  // reboot, crash), resume it automatically — 24/7 means 24/7.
  void readFile(automationStateFile, "utf8")
    .then((raw) => {
      if ((JSON.parse(raw) as { enabled?: boolean }).enabled) {
        isAutomationEnabled = true;
        startAutomationLoop();
        console.log("[AUTOMATION] Resumed hourly automation from saved state.");
      }
    })
    .catch(() => { /* no saved state yet */ });

  // ── Morning brief scheduler ───────────────────────────────────────────
  // Once a day, when the clock hits ATLAS_BRIEF_HOUR (UTC; default 12 ≈ 7-8am
  // US Eastern), email Mat the digest with a fresh magic link. Self-gating:
  // silent while the vault is locked, and won't double-send (tracked by date
  // in brief-digest.json). Checks every 15 min so it can't miss its window.
  const BRIEF_HOUR = Number(process.env.ATLAS_BRIEF_HOUR ?? 12);
  let briefTimer: NodeJS.Timeout | null = null;
  async function maybeSendMorningBrief(): Promise<void> {
    if (!vault.unlocked) return;
    const now = new Date();
    if (now.getUTCHours() !== BRIEF_HOUR) return;
    const today = now.toISOString().slice(0, 10);
    try {
      const raw = await readFile(briefStateFile, "utf8");
      if ((JSON.parse(raw) as { lastSentDate?: string }).lastSentDate === today) return; // already sent today
    } catch { /* never sent — fall through */ }
    try {
      await sendBriefDigest(process.env.ATLAS_PUBLIC_URL || "https://atlas.evervibesdigital.com");
      console.log("[BRIEF] Morning digest sent.");
    } catch (e) {
      console.error("[BRIEF] Morning digest failed:", (e as Error).message);
    }
  }
  function startBriefScheduler(): void {
    if (briefTimer) return;
    briefTimer = setInterval(() => void maybeSendMorningBrief(), 15 * 60 * 1000);
  }
  startBriefScheduler();

  let pendingRebuild: Promise<void> | null = null;

  /** Same as `setImmediate(rebuildAtlas)`, but tracks the in-flight promise so
   * `close()` can wait for it — a fire-and-forget rebuild must never race
   * shutdown-time cleanup (e.g. a test deleting its temp data dir). Chains onto
   * any already-pending rebuild instead of overwriting it, so `close()` always
   * waits for every scheduled rebuild, not just the most recently scheduled
   * one. Failures are logged (never silently swallowed) since a failed
   * rebuild leaves `atlas` pointing at a stale instance with no other signal. */
  /** Cached /api/capabilities scan. Cleared whenever the vault changes, since
   * a service's status flips from needs-key to ready the moment a key lands. */
  let capabilityCache: CapabilityStatus[] | null = null;

  function backgroundRebuild(): void {
    capabilityCache = null;
    pendingRebuild = (pendingRebuild ?? Promise.resolve()).then(
      () => new Promise<void>((resolve) => {
        setImmediate(() => { rebuildAtlas().then(resolve, (err) => { console.error("[REBUILD] background rebuild failed:", err); resolve(); }); });
      }),
    );
  }

  async function rebuildAtlas(): Promise<void> {
    if (vault.unlocked) {
      for (const k of vault.list()) {
        if (!k.startsWith(CRED_PREFIX)) {
          const val = vault.get(k);
          if (val) process.env[k] = val;
        }
      }
    }
    
    const livePublisher = new LiveBrowserPublisher({
      getInstagramCreds: async () => {
        const cred = vault.get("cred:instagram");
        return cred ? JSON.parse(cred) : null;
      }
    });

    atlas = await buildAtlas({
      brainAdapters: opts.brainAdapters,
      healEnabled: opts.healEnabled,
      actionsDriver: opts.actionsDriver,
      kdpDriver: opts.kdpDriver,
      kdpSessionFile: opts.kdpSessionFile,
      memoryFile: `${dataDir}/memory.json`,
      approvalsFile: `${dataDir}/approvals.json`,
      metricsFile: `${dataDir}/metrics.json`,
      proposalsFile: `${dataDir}/proposals-handled.json`,
      businessFile: `${dataDir}/businesses.json`,
      gigFile: `${dataDir}/gigs.json`,
      leadFile: `${dataDir}/leads.json`,
      vitalsFile: `${dataDir}/vitals-snapshot.json`,
      mediaFactoryImagesDir,
      toolVaultFile: `${dataDir}/toolvault.json`,
      skillsFile: `${dataDir}/skills.json`,
      auditFile: `${dataDir}/audit-log.json`,
      forgeDir: "./forge",
      publisher: livePublisher,
      videoJobsFile: videoJobsFile,
      socialAccountsFile: `${dataDir}/social-accounts.json`,
      socialPostsFile: socialPostsFile,
      socialInboxFile: socialInboxFile,
    });
    warmOllama(); // fire-and-forget: preload the local model so the first
    // offline reply isn't a 25s cold start (no-op if Ollama isn't running).
  }

  // Preload the local Ollama model into memory. keep_alive holds it resident so
  // subsequent replies are fast. Fully non-blocking and best-effort.
  function warmOllama(): void {
    const base = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
    fetch(`${base}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "llama3.2:3b", prompt: "hi", stream: false, keep_alive: "30m" }),
      signal: AbortSignal.timeout(60000),
    }).catch(() => {
      /* Ollama not running or slow — offline fallback still works, just cold */
    });
  }

  async function ensureAtlas(): Promise<Atlas> {
    if (!atlas) await rebuildAtlas();
    return atlas!;
  }

  // Auto-unlock on boot from an env-stored master password, if one is
  // provided — so ATLAS survives every VPS restart/redeploy without a manual
  // unlock (Mat's explicit choice, 2026-07-25: true 24/7 operation over the
  // small extra exposure of the password living as an env var on the same
  // VPS that already holds every other secret in this vault — not a new
  // machine to trust, just removing the one manual step). Silently a no-op
  // when ATLAS_MASTER_PASSWORD isn't set, so local/dev use is unaffected and
  // stays manual-unlock-only as always. Deliberately bypasses the
  // failedUnlocks/lockedUntil brute-force guard entirely — a wrong value here
  // is a deploy misconfiguration, not an attack, and must never lock Mat out
  // of unlocking manually afterward.
  //
  // Chained onto `pendingRebuild` (same tracked promise `backgroundRebuild()`
  // uses) rather than a bare fire-and-forget IIFE — otherwise close() has no
  // way to know to wait for it, and a test/shutdown that deletes its temp
  // data dir right after close() can race this still writing to it (the
  // exact bug class backgroundRebuild() was built to fix for the OTHER
  // background rebuild trigger, see the 2026-07-17 Run Ledger entry).
  function backgroundAutoUnlock(): void {
    const autoPassword = process.env.ATLAS_MASTER_PASSWORD;
    if (!autoPassword) return;
    pendingRebuild = (pendingRebuild ?? Promise.resolve()).then(
      () => new Promise<void>((resolve) => {
        setImmediate(() => {
          (async () => {
            if (!(await vault.exists())) return; // nothing to unlock yet
            await vault.unlock(autoPassword);
            token = randomUUID();
            await rebuildAtlas();
            console.log("[VAULT] Auto-unlocked from ATLAS_MASTER_PASSWORD on boot.");
          })().then(resolve, (err) => {
            console.error("[VAULT] Auto-unlock from ATLAS_MASTER_PASSWORD failed — falling back to manual unlock:", (err as Error).message);
            resolve();
          });
        });
      }),
    );
  }
  backgroundAutoUnlock();

  function send(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
        } catch {
          resolve({});
        }
      });
    });
  }

  const authed = (req: IncomingMessage): boolean => !!token && req.headers["x-atlas-token"] === token;

  // A second, narrowly-scoped credential for server-to-server reads — e.g.
  // evervibes' own morning-brief cron pulling ATLAS's pending items into the
  // SAME email it already sends, without needing Mat's live browser session
  // (the per-unlock `token` above is ephemeral and regenerates every unlock,
  // unusable for a service that runs on its own schedule). Deliberately only
  // wired to ONE read-only endpoint below, never the write/act side or
  // anything else the normal session token can reach.
  // Accept either name: ATLAS_LOGIN_TOKEN (current) or the older
  // ATLAS_SERVICE_TOKEN (kept as a fallback so an existing deploy that still
  // sets the old name doesn't silently lose service auth). Whichever is set
  // wins; ATLAS_LOGIN_TOKEN takes precedence when both exist.
  const ATLAS_SERVICE_TOKEN = process.env.ATLAS_LOGIN_TOKEN || process.env.ATLAS_SERVICE_TOKEN || "";
  const servicedAuthed = (req: IncomingMessage): boolean => !!ATLAS_SERVICE_TOKEN && req.headers["x-atlas-service-token"] === ATLAS_SERVICE_TOKEN;

  /** Build the plain-text morning digest + a fresh magic link, and send it to
   * the owner's own email. Returns what was sent. `baseUrl` is the public
   * origin the tap-link should point at. */
  async function sendBriefDigest(baseUrl: string): Promise<{ sent: boolean; to?: string; count: number; skipped?: string }> {
    if (!vault.unlocked) return { sent: false, count: 0, skipped: "vault locked" };
    const a = await ensureAtlas();
    const brief = (await a.invoke("brief", { op: "today" })) as { items: Array<{ source: string; title: string; detail?: string; tier: string }>; count: number };
    const items = brief.items ?? [];
    const tok = await signBriefToken();
    const link = `${baseUrl.replace(/\/+$/, "")}/m?t=${encodeURIComponent(tok)}`;
    const emails = items.filter((i) => i.tier === "bulk").length;
    const asks = items.filter((i) => i.tier === "ask").length;
    const lines = [
      `Good morning. Here's what ATLAS has ready.`,
      ``,
      `${items.length} item(s) waiting: ${asks} need your call, ${emails} email(s)/low-stakes you can batch-approve.`,
      ``,
      ...items.slice(0, 15).map((i) => `• [${i.source}] ${i.title}${i.detail ? ` — ${i.detail.slice(0, 120)}` : ""}`),
      items.length > 15 ? `…and ${items.length - 15} more.` : ``,
      ``,
      `👉 Review & approve from your phone (link good for 24h):`,
      link,
      ``,
      `— ATLAS`,
    ];
    const subject = `☀️ ATLAS morning brief — ${items.length} waiting (${asks} need you)`;
    const result = (await a.invoke("email", { op: "ownerNotify", subject, body: lines.filter((l) => l !== undefined).join("\n") })) as { to?: string };
    try {
      await writeFile(briefStateFile, JSON.stringify({ lastSentDate: new Date().toISOString().slice(0, 10), at: new Date().toISOString() }), "utf8");
    } catch { /* best-effort */ }
    return { sent: true, to: result.to, count: items.length };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";
    // Magic-link auth for the phone brief: a valid signed token in ?t= or the
    // x-brief-token header grants brief-ONLY access (read + approve/reject),
    // nothing else. Evaluated per-request so the mobile page and its API calls
    // both work without a full control-panel session.
    const briefTapAuthed = async (): Promise<boolean> => verifyBriefToken(url.searchParams.get("t") ?? (req.headers["x-brief-token"] as string | undefined));

    if (method === "GET" && path === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store, must-revalidate" });
      res.end(PAGE);
      return;
    }

    if (method === "GET" && path === "/api/health") {
      return send(res, 200, { ok: true, initialized: await vault.exists(), unlocked: vault.unlocked });
    }

    if (method === "GET" && path === "/api/social/oauth/callback") {
      const code = url.searchParams.get("code");
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h2>Connection failed</h2><p>No authorization code received.</p>");
        return;
      }
      try {
        const a = await ensureAtlas();
        const result = (await a.invoke("social", { op: "completeConnection", code })) as {
          connected: Array<{ platform: string; personaLabel: string }>;
        };
        const list = result.connected.map((c) => `<li>${c.platform}: <b>${c.personaLabel}</b></li>`).join("");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<h2>✅ Connected</h2><p>${result.connected.length} account(s) saved:</p><ul>${list}</ul><p style="color:#888;font-size:12px">You can close this tab.</p>`);
      } catch (err) {
        console.error("[SOCIAL] completeConnection failed:", (err as Error).message);
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(`<h2>Connection failed</h2><p>${(err as Error).message}</p><p style="color:#888;font-size:12px">Tell ATLAS this exact error — it's the real cause, not a guess.</p>`);
      }
      return;
    }

    if (method === "POST" && path === "/api/setup") {
      const { masterPassword } = await readBody(req);
      if (await vault.exists()) return send(res, 400, { error: "vault already exists — use unlock" });
      try {
        await vault.initialize(String(masterPassword ?? ""));
      } catch (e) {
        return send(res, 400, { error: (e as Error).message });
      }
      await vault.unlock(String(masterPassword));
      token = randomUUID();
      await rebuildAtlas();
      return send(res, 200, { token });
    }

    if (method === "POST" && path === "/api/unlock") {
      if (Date.now() < lockedUntil) {
        return send(res, 429, { error: "too many failed attempts — locked out, try again later" });
      }
      const { masterPassword } = await readBody(req);
      try {
        await vault.unlock(String(masterPassword ?? ""));
      } catch (e) {
        failedUnlocks++;
        if (failedUnlocks >= maxUnlockFails) {
          lockedUntil = Date.now() + lockoutMs;
          failedUnlocks = 0;
        }
        return send(res, 401, { error: (e as Error).message });
      }
      failedUnlocks = 0;
      token = randomUUID();
      await rebuildAtlas();
      return send(res, 200, { token });
    }

    // Live key validation — reveals only whether each provider accepts the
    // stored key, never the key itself. Session-gated: ATLAS is internet-facing
    // now, and this endpoint triggers outbound provider calls.
    if (method === "GET" && path === "/api/keys/test") {
      if (!authed(req)) return send(res, 401, { error: "locked — unlock first" });
      const get = (n: string): string => (vault.unlocked ? (vault.get(n) ?? process.env[n] ?? "") : (process.env[n] ?? ""));
      const probe = async (name: string, fn: (k: string) => Promise<Response>): Promise<{ name: string; status: string; detail: string }> => {
        const k = get(name);
        if (!k) return { name, status: "missing", detail: "no key saved" };
        try {
          const r = await fn(k);
          if (r.ok) return { name, status: "valid", detail: "provider accepted the key" };
          return { name, status: "INVALID", detail: `provider rejected it (HTTP ${r.status})` };
        } catch (e) {
          return { name, status: "unreachable", detail: String((e as Error).message).slice(0, 80) };
        }
      };
      // Database URLs aren't an HTTP API — probe them with a real pg connection
      // instead, using the exact same library media-factory-db.ts uses, so
      // whatever error surfaces here is the SAME error a plugin would hit, not
      // a heuristic guess from format-only validation.
      const probeDatabaseUrl = async (): Promise<{ name: string; status: string; detail: string }> => {
        const name = "DATABASE_URL";
        const k = get(name);
        if (!k) return { name, status: "missing", detail: "no key saved" };
        const pool = new pg.Pool({ connectionString: k, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000 });
        try {
          await pool.query("SELECT 1");
          return { name, status: "valid", detail: "connected successfully" };
        } catch (e) {
          return { name, status: "INVALID", detail: String((e as Error).message).slice(0, 200) };
        } finally {
          await pool.end().catch(() => {});
        }
      };
      const t = (ms: number) => AbortSignal.timeout(ms);
      const results = await Promise.all([
        probe("GEMINI_API_KEY", (k) => fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${k}`, { signal: t(8000) })),
        probe("GROQ_API_KEY", (k) => fetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${k}` }, signal: t(8000) })),
        probe("HUGGINGFACE_API_KEY", (k) => fetch("https://huggingface.co/api/whoami-v2", { headers: { Authorization: `Bearer ${k}` }, signal: t(8000) })),
        probe("TAVILY_API_KEY", (k) => fetch("https://api.tavily.com/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_key: k, query: "ping", max_results: 1 }), signal: t(8000) })),
        probe("OPENROUTER_API_KEY", (k) => fetch("https://openrouter.ai/api/v1/auth/key", { headers: { Authorization: `Bearer ${k}` }, signal: t(8000) })),
        probe("ANTHROPIC_API_KEY", (k) => fetch("https://api.anthropic.com/v1/models", { headers: { "x-api-key": k, "anthropic-version": "2023-06-01" }, signal: t(8000) })),
        probeDatabaseUrl(),
      ]);
      return send(res, 200, { results, testedAt: new Date().toISOString() });
    }

    // Service-token read access — GET /api/brief only, so evervibes' own
    // cron can pull today's items without Mat's browser session. Checked
    // before the blanket session gate below; every other endpoint stays
    // session-only.
    if (method === "GET" && path === "/api/brief" && servicedAuthed(req)) {
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("brief", { op: "today" }));
    }

    // ── Phone morning brief (magic-link, no session needed) ──────────────
    // The digest email links here. This route + the brief API calls it makes
    // are authorized by a signed token ONLY, and grant brief access ONLY.
    if (method === "GET" && path === "/m") {
      if (!(await briefTapAuthed())) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return void res.end(MOBILE_BRIEF_EXPIRED);
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return void res.end(MOBILE_BRIEF_PAGE);
    }
    // Brief API reachable with a valid magic-link token (read + act + bulk).
    if (path === "/api/brief" || path.startsWith("/api/brief/")) {
      if (await briefTapAuthed()) {
        const a = await ensureAtlas();
        if (method === "GET" && path === "/api/brief") {
          return send(res, 200, await a.invoke("brief", { op: "today" }));
        }
        if (method === "POST" && path === "/api/brief/bulk") {
          const { action, tier, source } = await readBody(req);
          if (action !== "approve" && action !== "reject") return send(res, 400, { error: "action must be 'approve' or 'reject'" });
          return send(res, 200, await a.invoke("brief", { op: "actBulk", action, tier: tier ?? "bulk", source: source || undefined }));
        }
        const tapAct = path.match(/^\/api\/brief\/([^/]+)\/([^/]+)$/);
        if (method === "POST" && tapAct && tapAct[1] !== "bulk") {
          const { action } = await readBody(req);
          if (action !== "approve" && action !== "reject") return send(res, 400, { error: "action must be 'approve' or 'reject'" });
          return send(res, 200, await a.invoke("brief", { op: "act", source: decodeURIComponent(tapAct[1]!), id: decodeURIComponent(tapAct[2]!), action }));
        }
      }
      // else: fall through to the session-gated copies below.
    }

    // ── everything below requires an unlocked session ──
    if (!authed(req)) return send(res, 401, { error: "locked — unlock first" });

    if (method === "POST" && path === "/api/lock") {
      vault.lock();
      token = null;
      atlas = null;
      return send(res, 200, { ok: true });
    }

    // ── Chat sessions + projects (Claude-like sidebar) ──
    if (method === "GET" && path === "/api/chats") {
      return send(res, 200, { sessions: await sessions.list(), projects: await sessions.projects() });
    }
    if (method === "GET" && path.startsWith("/api/chats/")) {
      const id = decodeURIComponent(path.slice("/api/chats/".length));
      const s = await sessions.get(id);
      return s ? send(res, 200, s) : send(res, 404, { error: "no such chat" });
    }
    if (method === "POST" && path === "/api/chats") {
      const { project, title } = await readBody(req);
      const s = await sessions.create(String(project ?? ""), String(title ?? "New chat"));
      return send(res, 200, s);
    }
    if (method === "PATCH" && path.startsWith("/api/chats/")) {
      const id = decodeURIComponent(path.slice("/api/chats/".length));
      const { title, project, deleted } = await readBody(req);
      if (typeof title === "string") await sessions.rename(id, title);
      if (typeof project === "string") await sessions.setProject(id, project);
      if (typeof deleted === "boolean") await sessions.setDeleted(id, deleted);
      const s = await sessions.get(id);
      return s ? send(res, 200, s) : send(res, 404, { error: "no such chat" });
    }
    if (method === "DELETE" && path.startsWith("/api/chats/")) {
      const id = decodeURIComponent(path.slice("/api/chats/".length));
      const purge = url.searchParams.get("purge") === "true";
      const ok = await sessions.remove(id, purge);
      return send(res, ok ? 200 : 404, { ok });
    }

    // Per-service honest status: is it wired, and does it have what it needs to
    // actually run? Answers "will this work if I press the button" without
    // pressing it. Cached because it reads every source file, and the source
    // cannot change without a redeploy that restarts this process anyway.
    if (method === "GET" && path === "/api/capabilities") {
      if (!capabilityCache) {
        try {
          capabilityCache = capabilityReport(loadSourceFiles(resolve(process.cwd(), "packages")), vault.list());
        } catch (err) {
          return send(res, 500, { error: `capability scan failed: ${(err as Error).message}` });
        }
      }
      const counts = { ready: 0, "needs-key": 0, partial: 0, unreachable: 0 };
      for (const c of capabilityCache) counts[c.status]++;
      return send(res, 200, { services: capabilityCache, counts });
    }

    if (method === "GET" && path === "/api/secrets") {
      const names = vault.list().filter((k) => !k.startsWith(CRED_PREFIX));
      const providers = Object.fromEntries(KNOWN_PROVIDERS.map((p) => [p, names.includes(p)]));
      // Custom/unknown keys (any NAME that's not in KNOWN_PROVIDERS)
      const customKeys = names.filter((n) => !KNOWN_PROVIDERS.includes(n));
      return send(res, 200, { names, providers, customKeys });
    }
    if (method === "POST" && path === "/api/secrets") {
      const { name, value } = await readBody(req);
      if (!name || !value) return send(res, 400, { error: "name and value required" });
      const problem = validateSecretValue(String(name), String(value));
      if (problem) return send(res, 400, { error: problem });
      await vault.set(String(name), String(value));
      // Rebuild in the background so HTTP response returns immediately.
      backgroundRebuild();
      return send(res, 200, { ok: true });
    }
    if (method === "POST" && path === "/api/secrets/bulk") {
      const { text } = await readBody(req);
      const pairs = parseKeyLines(String(text ?? ""));
      const problems: string[] = [];
      const valid: typeof pairs = [];
      for (const p of pairs) {
        const problem = validateSecretValue(p.name, p.value);
        if (problem) problems.push(problem);
        else valid.push(p);
      }
      for (const p of valid) await vault.set(p.name, p.value);
      // Rebuild in the background so HTTP response returns immediately
      // (rebuilding can take 10-30s with Ollama; don't block the browser).
      if (valid.length) backgroundRebuild();
      return send(res, 200, { saved: valid.length, names: valid.map((p) => p.name), problems });
    }
    if (method === "DELETE" && path.startsWith("/api/secrets/")) {
      const name = decodeURIComponent(path.slice("/api/secrets/".length));
      const ok = await vault.delete(name);
      // Rebuild in the background so HTTP response returns immediately.
      backgroundRebuild();
      return send(res, 200, { ok });
    }

    // Smart key detection: paste raw text, get back detected keys with metadata + values
    if (method === "POST" && path === "/api/detect-keys") {
      const { text } = await readBody(req);
      const detected = detectSecrets(String(text ?? ""));
      const saved = new Set(vault.list());
      const results = detected.map((d) => ({
        name: d.name,
        label: d.label,
        category: d.category,
        free: d.free,
        sensitive: d.sensitive,
        value: d.value, // Already extracted by detectSecrets
        alreadySaved: saved.has(d.name),
      }));
      return send(res, 200, { detected: results, total: results.length });
    }

    if (method === "GET" && path === "/api/automation") {
      return send(res, 200, {
        enabled: isAutomationEnabled,
        lastRun: lastAutomationRun,
        running: isAutomationRunning
      });
    }
    if (method === "POST" && path === "/api/automation") {
      try {
        const { enabled } = await readBody(req) as any;
        isAutomationEnabled = !!enabled;
        if (isAutomationEnabled) {
          startAutomationLoop();
        } else if (automationIntervalId) {
          clearInterval(automationIntervalId);
          automationIntervalId = null;
          console.log("[AUTOMATION] Hourly automation loop stopped.");
        }
        await persistAutomationState();
        return send(res, 200, { ok: true, enabled: isAutomationEnabled });
      } catch (err) {
        return send(res, 500, { error: (err as Error).message });
      }
    }

    if (method === "GET" && path === "/api/credentials") {
      const credentials = vault
        .list()
        .filter((k) => k.startsWith(CRED_PREFIX))
        .map((k) => {
          const parsed = JSON.parse(vault.get(k) ?? "{}") as { username?: string };
          return { platform: k.slice(CRED_PREFIX.length), username: parsed.username ?? "" };
        });
      return send(res, 200, { credentials });
    }
    if (method === "POST" && path === "/api/credentials") {
      const { platform, username, password, notes } = await readBody(req);
      if (!platform || !username) return send(res, 400, { error: "platform and username required" });
      await vault.set(CRED_PREFIX + String(platform), JSON.stringify({ username, password: password ?? "", notes: notes ?? "" }));
      return send(res, 200, { ok: true });
    }
    if (method === "DELETE" && path.startsWith("/api/credentials/")) {
      const platform = decodeURIComponent(path.slice("/api/credentials/".length));
      const ok = await vault.delete(CRED_PREFIX + platform);
      return send(res, 200, { ok });
    }

    // === Virtual Media Factory Endpoints (bridges to the "mediaFactory" plugin) ===
    if (method === "GET" && path === "/api/media-factory/creators") {
      try {
        const a = await ensureAtlas();
        return send(res, 200, await a.invoke("mediaFactory", { op: "listCreators" }));
      } catch (err) {
        return send(res, 500, { error: (err as Error).message });
      }
    }
    if (method === "POST" && path === "/api/media-factory/creators") {
      try {
        const data = await readBody(req);
        const a = await ensureAtlas();
        return send(res, 200, await a.invoke("mediaFactory", { op: "createCreator", creator: data }));
      } catch (err) {
        return send(res, 500, { error: (err as Error).message });
      }
    }
    if (method === "POST" && path === "/api/media-factory/creators/generate-random") {
      try {
        const { niche } = await readBody(req);
        const a = await ensureAtlas();
        return send(res, 200, await a.invoke("mediaFactory", { op: "generateRandomCreator", niche: niche || undefined }));
      } catch (err) {
        return send(res, 500, { error: (err as Error).message });
      }
    }
    if (method === "PATCH" && path.startsWith("/api/media-factory/creators/")) {
      try {
        const id = decodeURIComponent(path.slice("/api/media-factory/creators/".length));
        const data = await readBody(req);
        const a = await ensureAtlas();
        return send(res, 200, await a.invoke("mediaFactory", { op: "updateCreator", id, patch: data }));
      } catch (err) {
        return send(res, 500, { error: (err as Error).message });
      }
    }
    if (method === "DELETE" && path.startsWith("/api/media-factory/creators/")) {
      try {
        const id = decodeURIComponent(path.slice("/api/media-factory/creators/".length));
        const a = await ensureAtlas();
        return send(res, 200, await a.invoke("mediaFactory", { op: "deleteCreator", id }));
      } catch (err) {
        return send(res, 500, { error: (err as Error).message });
      }
    }

    if (method === "GET" && path.startsWith("/api/media-factory/memories/")) {
      try {
        const creatorId = decodeURIComponent(path.slice("/api/media-factory/memories/".length));
        const a = await ensureAtlas();
        return send(res, 200, await a.invoke("mediaFactory", { op: "listMemories", creatorId }));
      } catch (err) {
        return send(res, 500, { error: (err as Error).message });
      }
    }
    if (method === "POST" && path === "/api/media-factory/memories") {
      try {
        const data = await readBody(req);
        const a = await ensureAtlas();
        return send(res, 200, await a.invoke("mediaFactory", { op: "addMemory", memory: data }));
      } catch (err) {
        return send(res, 500, { error: (err as Error).message });
      }
    }

    if (method === "GET" && path === "/api/media-factory/content") {
      try {
        const creatorId = url.searchParams.get("creatorId") || undefined;
        const a = await ensureAtlas();
        return send(res, 200, await a.invoke("mediaFactory", { op: "listContent", creatorId }));
      } catch (err) {
        return send(res, 500, { error: (err as Error).message });
      }
    }
    if (method === "POST" && path === "/api/media-factory/content") {
      try {
        const data = await readBody(req);
        const a = await ensureAtlas();
        return send(res, 200, await a.invoke("mediaFactory", { op: "createContent", item: data }));
      } catch (err) {
        return send(res, 500, { error: (err as Error).message });
      }
    }
    if (method === "PATCH" && path.startsWith("/api/media-factory/content/")) {
      try {
        const id = decodeURIComponent(path.slice("/api/media-factory/content/".length));
        const bodyData = await readBody(req);
        const a = await ensureAtlas();
        return send(res, 200, await a.invoke("mediaFactory", { op: "updateContentStatus", id, status: String(bodyData?.status ?? ""), publishedAt: bodyData?.publishedAt ? String(bodyData.publishedAt) : undefined }));
      } catch (err) {
        return send(res, 500, { error: (err as Error).message });
      }
    }

    if (method === "POST" && path === "/api/media-factory/scout") {
      try {
        const bodyData = await readBody(req);
        if (!bodyData?.niche) return send(res, 400, { error: "niche is required" });
        const a = await ensureAtlas();
        return send(res, 200, await a.invoke("mediaFactory", { op: "scout", niche: String(bodyData.niche) }));
      } catch (err) {
        return send(res, 500, { error: (err as Error).message });
      }
    }
    if (method === "POST" && path === "/api/media-factory/plan") {
      try {
        const bodyData = await readBody(req);
        if (!bodyData?.creatorId) return send(res, 400, { error: "creatorId is required" });
        const a = await ensureAtlas();
        return send(res, 200, await a.invoke("mediaFactory", { op: "plan", creatorId: String(bodyData.creatorId), trendsSummary: bodyData.trendsSummary ? String(bodyData.trendsSummary) : undefined }));
      } catch (err) {
        return send(res, 500, { error: (err as Error).message });
      }
    }
    if (method === "POST" && path === "/api/media-factory/produce") {
      try {
        const bodyData = await readBody(req);
        if (!bodyData?.creatorId || !bodyData?.title || !bodyData?.hook || !bodyData?.platform) {
          return send(res, 400, { error: "creatorId, title, hook, platform required" });
        }
        const a = await ensureAtlas();
        return send(res, 200, await a.invoke("mediaFactory", {
          op: "produce",
          creatorId: String(bodyData.creatorId),
          title: String(bodyData.title),
          hook: String(bodyData.hook),
          brief: bodyData.brief ? String(bodyData.brief) : undefined,
          platform: String(bodyData.platform),
          contentId: bodyData.contentId ? String(bodyData.contentId) : undefined,
        }));
      } catch (err) {
        return send(res, 500, { error: (err as Error).message });
      }
    }
    // Serve a generated persona image from disk. Path is "<creatorId>/<file>"
    // — validated to stay inside mediaFactoryImagesDir (no traversal).
    if (method === "GET" && path.startsWith("/api/media-factory/image/")) {
      const rel = decodeURIComponent(path.slice("/api/media-factory/image/".length));
      const full = resolvePathSafe(mediaFactoryImagesDir, rel);
      if (!full) return send(res, 400, { error: "invalid path" });
      try {
        const buf = await readFile(full);
        const ext = full.split(".").pop()?.toLowerCase();
        const type = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
        res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=86400" });
        return void res.end(buf);
      } catch {
        return send(res, 404, { error: "image not found" });
      }
    }
    if (method === "POST" && path === "/api/media-factory/auto-cycle") {
      try {
        const a = await ensureAtlas();
        return send(res, 200, await a.invoke("mediaFactory", { op: "autoCycle" }));
      } catch (err) {
        return send(res, 500, { error: (err as Error).message });
      }
    }

    if (method === "GET" && path.startsWith("/api/media-factory/partnerships/")) {
      try {
        const creatorId = decodeURIComponent(path.slice("/api/media-factory/partnerships/".length));
        const a = await ensureAtlas();
        return send(res, 200, await a.invoke("mediaFactory", { op: "listPartnerships", creatorId }));
      } catch (err) {
        return send(res, 500, { error: (err as Error).message });
      }
    }
    if (method === "POST" && path === "/api/media-factory/partnerships") {
      try {
        const data = await readBody(req);
        const a = await ensureAtlas();
        return send(res, 200, await a.invoke("mediaFactory", { op: "addPartnership", partnership: data }));
      } catch (err) {
        return send(res, 500, { error: (err as Error).message });
      }
    }

    if (method === "GET" && path.startsWith("/api/media-factory/analytics/")) {
      try {
        const creatorId = decodeURIComponent(path.slice("/api/media-factory/analytics/".length));
        const a = await ensureAtlas();
        return send(res, 200, await a.invoke("mediaFactory", { op: "getAnalytics", creatorId }));
      } catch (err) {
        return send(res, 500, { error: (err as Error).message });
      }
    }
    if (method === "POST" && path === "/api/media-factory/analytics") {
      try {
        const data = await readBody(req);
        const a = await ensureAtlas();
        return send(res, 200, await a.invoke("mediaFactory", { op: "saveAnalytics", snapshot: data }));
      } catch (err) {
        return send(res, 500, { error: (err as Error).message });
      }
    }

    // CFO + Advisors on-demand endpoints — cfo.forecast/roi and
    // knowledge.playbook/archaeologist.dig are fully built ops with no
    // route until now; same try/catch shape as every route above.
    if (method === "POST" && path === "/api/cfo/forecast") {
      try {
        const body = await readBody(req);
        if (body?.cashOnHand === undefined || body?.monthlyExpenses === undefined) {
          return send(res, 400, { error: "cashOnHand and monthlyExpenses are required" });
        }
        const a = await ensureAtlas();
        return send(res, 200, await a.invoke("cfo", {
          op: "forecast",
          inputs: {
            cashOnHand: Number(body.cashOnHand),
            monthlyExpenses: Number(body.monthlyExpenses),
            monthlyRevenue: body.monthlyRevenue !== undefined ? Number(body.monthlyRevenue) : undefined,
          },
        }));
      } catch (err) {
        return send(res, 500, { error: (err as Error).message });
      }
    }
    if (method === "POST" && path === "/api/cfo/roi") {
      try {
        const body = await readBody(req);
        if (body?.cost === undefined || body?.expectedReturn === undefined) {
          return send(res, 400, { error: "cost and expectedReturn are required" });
        }
        const a = await ensureAtlas();
        return send(res, 200, await a.invoke("cfo", { op: "roi", cost: Number(body.cost), expectedReturn: Number(body.expectedReturn) }));
      } catch (err) {
        return send(res, 500, { error: (err as Error).message });
      }
    }
    if (method === "POST" && path === "/api/knowledge/playbook") {
      try {
        const body = await readBody(req);
        if (!body?.topic) return send(res, 400, { error: "topic is required" });
        const a = await ensureAtlas();
        return send(res, 200, await a.invoke("knowledge", { op: "playbook", topic: String(body.topic), limit: body.limit !== undefined ? Number(body.limit) : undefined }));
      } catch (err) {
        return send(res, 500, { error: (err as Error).message });
      }
    }
    if (method === "POST" && path === "/api/archaeologist/dig") {
      try {
        const body = await readBody(req);
        const a = await ensureAtlas();
        return send(res, 200, await a.invoke("archaeologist", { op: "dig", topic: body?.topic ? String(body.topic) : undefined }));
      } catch (err) {
        return send(res, 500, { error: (err as Error).message });
      }
    }

    // Media Factory "Produce Video" trigger + job status/serving — the op
    // (mediaFactory.produceVideo) already worked and already persists
    // assets.video_job_id onto the content item; this just gives it a route
    // and a way to check the render job it kicks off back later.
    if (method === "POST" && path === "/api/media-factory/produce-video") {
      try {
        const body = await readBody(req);
        if (!body?.contentId) return send(res, 400, { error: "contentId is required" });
        const a = await ensureAtlas();
        return send(res, 200, await a.invoke("mediaFactory", { op: "produceVideo", contentId: String(body.contentId) }));
      } catch (err) {
        return send(res, 500, { error: (err as Error).message });
      }
    }
    if (method === "GET" && path.startsWith("/api/publishing/video-job/")) {
      try {
        const jobId = decodeURIComponent(path.slice("/api/publishing/video-job/".length));
        const a = await ensureAtlas();
        return send(res, 200, await a.invoke("publishing", { op: "getVideoJob", jobId }));
      } catch (err) {
        return send(res, 500, { error: (err as Error).message });
      }
    }
    if (method === "GET" && path.startsWith("/api/publishing/video/")) {
      try {
        const jobId = decodeURIComponent(path.slice("/api/publishing/video/".length));
        const a = await ensureAtlas();
        const { job } = (await a.invoke("publishing", { op: "getVideoJob", jobId })) as { job: { status: string; resultPath?: string } | null };
        if (!job || job.status !== "done" || !job.resultPath) return send(res, 404, { error: "video not ready" });
        const full = resolvePathSafe(process.cwd(), job.resultPath);
        if (!full) return send(res, 404, { error: "video not ready" });
        try {
          const buf = await readFile(full);
          res.writeHead(200, { "Content-Type": "video/mp4", "Cache-Control": "public, max-age=86400" });
          return void res.end(buf);
        } catch {
          return send(res, 404, { error: "video not ready" });
        }
      } catch (err) {
        return send(res, 500, { error: (err as Error).message });
      }
    }

    // Self-improvement endpoints (ATLAS modifies itself)
    if (method === "POST" && path === "/api/self-improve") {
      const improveReq = (await readBody(req)) as unknown;
      const selfReq = improveReq as SelfImprovementRequest;
      if (!selfReq.target || !selfReq.goal) return send(res, 400, { error: "target and goal required" });

      // Read the current code
      const target = await getSelfImprovementTarget(selfReq.target);
      if (!target) return send(res, 404, { error: `unknown target: ${selfReq.target}` });

      // Generate draft using the local brain (Ollama only, free)
      const a = await ensureAtlas();
      const draft = await generateSelfImprovementDraft(selfReq, target.code, async (cmd: unknown) => {
        return (await a.invoke("brain", cmd)) as { text: string };
      });

      if (!draft) return send(res, 500, { error: "failed to generate draft" });

      // Store it for Mat to review
      const id = randomUUID();
      selfImprovementDrafts.set(id, draft);

      return send(res, 200, { id, draft });
    }

    if (method === "GET" && path === "/api/self-improve/drafts") {
      const drafts = Array.from(selfImprovementDrafts.entries()).map(([id, draft]) => ({
        id,
        target: draft.target,
        goal: draft.goal,
        confidence: draft.confidence,
        estimatedImpact: draft.estimatedImpact,
        explanation: draft.explanation.slice(0, 100),
      }));
      return send(res, 200, { drafts });
    }

    if (method === "GET" && path.startsWith("/api/self-improve/drafts/")) {
      const id = path.slice("/api/self-improve/drafts/".length);
      const draft = selfImprovementDrafts.get(id);
      if (!draft) return send(res, 404, { error: "draft not found" });
      return send(res, 200, { id, draft });
    }

    if (method === "POST" && path === "/api/self-improve/apply") {
      const { id, approved } = await readBody(req);
      const draft = selfImprovementDrafts.get(String(id ?? ""));
      if (!draft) return send(res, 404, { error: "draft not found" });
      if (!approved) return send(res, 200, { ok: false, message: "draft rejected" });

      // Apply safely: backup → write → typecheck → auto-rollback on failure.
      const result = await applySelfImprovementPatch(draft.target, draft.suggestedPatch);
      if (!result.ok) return send(res, 500, { error: result.error });

      // Clean up the draft and rebuild
      selfImprovementDrafts.delete(String(id ?? ""));
      backgroundRebuild();

      return send(res, 200, { ok: true, message: `Applied to ${draft.target} — ${result.verified}. Rebuilding...` });
    }

    // Proposals → Task Queue (close the learning loop)
    if (method === "GET" && path === "/api/proposals") {
      const a = await ensureAtlas();
      const proposals = (await a.invoke("learning", { op: "proposals" })) as unknown[];
      return send(res, 200, { proposals: proposals || [] });
    }

    if (method === "POST" && path === "/api/proposals/adopt") {
      const { category } = await readBody(req);
      if (!category) return send(res, 400, { error: "category required" });
      const a = await ensureAtlas();
      // Adoption is REAL: the directive goes into the same memory that the
      // chat and the daily cycle (step 1b) search before deciding anything.
      // Routed through the learning plugin's own "adopt" op (not written here
      // directly) so this tab and the Unified Brief's "approve" both resolve
      // through the exact same path — see packages/brief/src/plugin.ts.
      const result = (await a.invoke("learning", { op: "adopt", category: String(category) })) as { message: string };
      return send(res, 200, { ok: true, message: result.message });
    }

    if (method === "POST" && path === "/api/chat") {
      const { message, history, sessionId, unfiltered } = await readBody(req);
      if (!message) return send(res, 400, { error: "message required" });
      const a = await ensureAtlas();
      const started = Date.now();
      // Persist the user's turn into the session (if one was supplied).
      const sid = typeof sessionId === "string" && sessionId ? sessionId : "";
      if (sid) await sessions.append(sid, { role: "user", text: String(message) });
      const saveBot = async (reply: string, provider: string, model: string): Promise<void> => {
        if (sid) await sessions.append(sid, { role: "bot", text: reply, provider, model });
      };

      // ── SMART INTAKE: detect API keys, store them in the vault, and REDACT
      //    them so their values never touch the AI, the logs, or memory. ──
      const secrets = detectSecrets(String(message));
      const storedNotes: string[] = [];
      if (secrets.length) {
        for (const s of secrets) {
          await vault.set(s.name, s.value);
          try {
            await a.invoke("toolvault", { op: "add", tool: { name: s.label, category: s.category, quality: 4, free: s.free, approved: s.approved } });
          } catch {
            /* toolvault optional */
          }
          storedNotes.push(`${s.label} (${s.name})${s.sensitive ? " ⚠ sensitive — rotate if this was pasted anywhere public" : ""}`);
        }
        await rebuildAtlas(); // pick up any new LLM keys immediately
      }
      const safeMessage = redactSecrets(String(message), secrets);
      const storedBanner = storedNotes.length ? `🔒 Stored ${storedNotes.length} key(s) securely in your vault (values never sent to the AI):\n• ${storedNotes.join("\n• ")}\n\n` : "";

      // FRUGAL short-circuit: answer trivial messages with no LLM call at all.
      const quick = trivialReply(safeMessage);
      if (quick) {
        await saveBot(storedBanner + quick, "frugal", "no-llm");
        return send(res, 200, { reply: storedBanner + quick, provider: "frugal", model: "no-llm", latencyMs: Date.now() - started, stored: storedNotes.length });
      }

      // COMMAND ROUTER: if the message is a "do X" request, run the real agent.
      const intent = routeChatIntent(safeMessage);
      if (intent) {
        // A "run today's cycle" chat command shares the same isAutomationRunning
        // guard as the hourly automation loop — without this, asking for a
        // manual cycle while the hourly loop happens to be mid-run would start
        // a SECOND concurrent runDailyCycle in the same process. Most cycle
        // steps tolerate that fine, but codebase.heal does real `git commit`s
        // and workspace typechecks; two of those running at once risk a git
        // index-lock collision. Blocking here (rather than inside the
        // orchestrator) stops the double-invocation at its root, so every
        // step benefits, not just heal.
        if (intent.kind === "cycle" && isAutomationRunning) {
          const reply = `${storedBanner}⏳ A cycle is already running (started by the automatic hourly loop) — let it finish before starting another one, so nothing runs twice at once.`;
          await saveBot(reply, "agent:orchestrator", "cycle");
          return send(res, 200, { reply, provider: "agent:orchestrator", model: "cycle", latencyMs: Date.now() - started, stored: storedNotes.length });
        }
        const holdsAutomationGuard = intent.kind === "cycle";
        if (holdsAutomationGuard) isAutomationRunning = true;
        try {
          let result: unknown;
          try {
            result = await a.invoke(intent.service, intent.payload);
          } finally {
            if (holdsAutomationGuard) isAutomationRunning = false;
          }
          const reply = `${storedBanner}${intent.intro}\n${formatIntentResult(intent.kind, result)}`;
          try {
            await a.invoke("memory", { op: "remember", input: { kind: "conversation", content: `Mat asked ATLAS to ${intent.kind}: ${safeMessage.slice(0, 200)}` } });
          } catch {
            /* memory optional */
          }
          await saveBot(reply, `agent:${intent.service}`, intent.kind);
          return send(res, 200, { reply, provider: `agent:${intent.service}`, model: intent.kind, latencyMs: Date.now() - started, stored: storedNotes.length });
        } catch {
          /* agent failed (e.g. missing key) — fall through to a normal reply */
        }
      }

      // Recall memories related to what Mat is asking (best-effort, redacted).
      let recalled = "";
      try {
        const hits = (await a.invoke("memory", { op: "search", query: safeMessage, options: { limit: 3, minScore: 0.15 } })) as Array<{ record: { content: string } }>;
        if (hits.length) recalled = "Things you remember that may be relevant:\n" + hits.map((h) => `- ${h.record.content}`).join("\n");
      } catch {
        /* memory optional */
      }

      const turns = Array.isArray(history) ? (history as Array<{ role: string; text: string }>).slice(-10) : [];
      const convo = turns.map((t) => `${t.role === "user" ? "Mat" : "ATLAS"}: ${t.text}`).join("\n");

      // This block is NOT a content-policy rule — it's a factual constraint that
      // applies identically whether or not unfiltered mode is on: a free-text
      // chat reply never executes anything, ever, so claiming otherwise is
      // always a lie regardless of how open the conversation's topics are.
      const antiFabricationRule = [
        "HARD RULE — THIS CHAT REPLY IS TEXT ONLY, NOTHING ELSE HAPPENS:",
        "Right now, in this exact reply, you are NOT executing any tool, NOT browsing any website, NOT sending any email, NOT creating any account, NOT submitting any bid or proposal, and NOT verifying anything. You are only generating text. This is true no matter how the conversation has gone, no matter what Mat has asked for, and no matter how many times he says 'confirm' or 'proceed' or 'do it 100%'.",
        "NEVER claim, imply, or narrate that you have: registered an account, signed up for a platform, created a profile or storefront, submitted or sent a bid/proposal/application/email/pitch, verified an account or email, logged into an inbox, bypassed a CAPTCHA or security check, or that anything is now 'live' or 'active' or 'published'. If none of these things are technically possible for you to do from a chat reply — and they are not — do not say you did them. Making up a success story is a serious failure, worse than saying 'I can't do that.'",
        "The ONLY real actions ATLAS can take are the specific commands listed below, each of which calls a real, tested capability. Everything else — including anything about signing up for freelance sites, using any email inbox, or handling real credentials — is NOT something you can do, full stop. Say so plainly if asked. This list changes as real capabilities get built — trust it over any assumption from earlier in the conversation or from what ATLAS used to be able to do.",
        "You can trigger REAL actions only via these exact phrases (say the phrase back to Mat, don't pretend to already have done it): 'find free X apis', 'scout github for X', 'search for X', 'find the website for X', 'run today's cycle', 'red team: <idea>', 'learn <url>', 'give me ideas', 'business brief', 'check email' (reads only, via the real email plugin), 'connect instagram'/'connect facebook' (generates a real Meta account-connection link for Mat to open and authorize — this is a real, working capability as of 2026-07-27).",
        "IMPORTANT — automatic posting is NOT built yet: ATLAS can generate a real connection link ('connect instagram'/'connect facebook') and Mat can authorize it, but ATLAS cannot yet automatically publish posts, read comments/DMs, or reply to anyone on Instagram/Facebook — that capability is still being built. If Mat mentions upgrades, new abilities, giving ATLAS access tokens, or asks whether ATLAS can post now: do not flatly deny all social media capability (that's now false) and do not claim posting works (that's also false) — say plainly that account connection is real and working today, but automatic posting isn't built yet, and ask what he'd like to do next.",
        "If Mat asks you to do something outside these commands (e.g. 'sign up for Upwork', 'submit this bid', 'use my email to register'), tell him directly that this isn't something ATLAS can do yet, and point him to the real, working feature that's closest (e.g. the Gig Finder tab drafts pitches for HIM to send).",
        "The vault stores secrets Mat has actually saved. If the CURRENT message includes a stored-key confirmation banner, acknowledge exactly what's shown — never invent a new secret name or claim something is 'saved' that wasn't just shown to you.",
      ].join(" ");

      const system = unfiltered
        ? [
            "You are ATLAS running in Unfiltered mode, on Mat's own local machine via a local model (Dolphin), talking only to Mat, the owner.",
            "Answer directly and candidly. Don't add moral disclaimers, hedge with 'I can't help with that' on ordinary mature/edgy/controversial/legal-but-sensitive topics, or refuse a question just because a mainstream hosted AI would. Swear if it fits. Give your own blunt opinion when asked.",
            "This is not a license to help with things that would seriously hurt real people: don't give working instructions for weapons capable of mass harm, malware meant to attack someone else's systems, or sexual content involving minors — refuse those plainly, same as always. Everything short of that, engage with honestly.",
            "If you don't know something, say so honestly — don't fabricate facts to sound confident.",
            "",
            antiFabricationRule,
          ].join(" ")
        : [
            "You are ATLAS — Mat's autonomous AI Operating System (AI That Learns, Acts & Scales).",
            "You run his businesses' agents: creative (Instagram Reels), publishing (approval-gated), CFO, strategy board, research, learning, curiosity, red-team, gig finder, KDP, media factory, and more.",
            "Mat is a non-technical founder; explain plainly, be direct and useful, and give complete answers (don't cut yourself off).",
            "",
            antiFabricationRule,
            "If you don't know something, say so honestly.",
          ].join(" ");

      const prompt = [recalled, convo, `Mat: ${safeMessage}`, "ATLAS:"].filter(Boolean).join("\n\n");

      const resp = (await a.invoke("brain", {
        prompt,
        system,
        needs: unfiltered ? { ...chatNeeds(safeMessage), unfiltered: 1 } : chatNeeds(safeMessage),
        maxTokens: 2048,
        task: unfiltered ? "owner.chat.unfiltered" : "owner.chat",
      })) as { text: string; provider: string; model: string };

      // MECHANICAL safety net (see chat-safety.ts): prompting the model not to
      // fabricate completed real-world actions already failed once in
      // practice, so this doesn't rely on the model cooperating. Free-text
      // replies never execute anything — if the reply CLAIMS otherwise
      // (registered an account, submitted a bid, verified an email, etc.),
      // it's always false, and we replace it before Mat ever sees it.
      const fabrication = checkFabricatedActionClaim(resp.text);
      if (fabrication.flagged) {
        resp.text = FABRICATION_CORRECTION(resp.text);
        try {
          await a.invoke("memory", {
            op: "remember",
            input: { kind: "task", content: `SAFETY: chat reply blocked for fabricating a completed action (matched: ${fabrication.matchedPatterns.join(", ")}). Provider: ${resp.provider}/${resp.model}.` },
          });
        } catch {
          /* memory optional */
        }
      } else {
        // Evaluation Layer — broader than the fabrication regex list: catches
        // absolute-certainty overclaims ("guaranteed", "zero risk") and low
        // groundedness against what was actually recalled from memory. Only a
        // logging pass for now (fabrication above already owns text rewrites,
        // to keep one code path responsible for mutating what Mat sees).
        try {
          const evalResult = (await a.invoke("evaluation", {
            op: "score",
            task: "chat.reply",
            text: resp.text,
            context: recalled ? [recalled] : [],
          })) as { confidence: number; issues: string[] };
          if (evalResult.issues.length > 0) {
            await a.invoke("memory", {
              op: "remember",
              input: { kind: "task", content: `EVAL: chat reply confidence ${evalResult.confidence.toFixed(2)} (${evalResult.issues.join("; ")}). Provider: ${resp.provider}/${resp.model}.` },
            });
          }
        } catch {
          /* evaluation optional */
        }
      }

      // Save the REDACTED exchange to memory (never the secret values).
      try {
        await a.invoke("memory", {
          op: "remember",
          input: { kind: "conversation", content: `Mat asked: ${safeMessage.slice(0, 300)} | ATLAS answered: ${resp.text.slice(0, 300)}` },
        });
      } catch {
        /* memory optional */
      }

      await saveBot(storedBanner + resp.text, resp.provider, resp.model);
      return send(res, 200, { reply: storedBanner + resp.text, provider: resp.provider, model: resp.model, latencyMs: Date.now() - started, stored: storedNotes.length });
    }

    if (method === "POST" && path === "/api/export-env") {
      // Copy provider keys from the (unlocked) vault into a local git-ignored
      // .env so automated runs — the nightly task and `pnpm cycle` — can use
      // real models without needing the master password at 2:30 AM.
      let existing = "";
      try {
        existing = await readFile(envFile, "utf8");
      } catch {
        /* no .env yet */
      }
      // Export ALL non-credential secrets (LLM keys + GitHub/Vercel/Supabase/
      // Tavily/etc.) so the overnight cycle can do everything, not just chat.
      const names = vault.list().filter((k) => !k.startsWith(CRED_PREFIX));
      const kept = existing.split(/\r?\n/).filter((l) => l.trim() && !names.some((p) => l.startsWith(`${p}=`)));
      const exported: string[] = [];
      for (const p of names) {
        const val = vault.get(p);
        if (val) exported.push(`${p}=${val}`);
      }
      await writeFile(envFile, [...kept, ...exported].join("\n") + "\n", "utf8");
      return send(res, 200, { ok: true, exported: exported.length });
    }

    // ── Task queue (async work with approval gates) ──
    if (method === "GET" && path === "/api/tasks") {
      return send(res, 200, {
        tasks: queue.list(),
        pendingApprovals: queue.pendingApprovals(),
        stats: { total: queue.list().length, executing: queue.list().filter((t: any) => t.status === "executing").length },
      });
    }
    if (method === "GET" && path.startsWith("/api/tasks/")) {
      const taskId = decodeURIComponent(path.slice("/api/tasks/".length));
      const t = queue.get(taskId);
      return t ? send(res, 200, t) : send(res, 404, { error: "no such task" });
    }
    if (method === "POST" && path.startsWith("/api/tasks/") && path.endsWith("/approve")) {
      const taskId = decodeURIComponent(path.slice("/api/tasks/".length, -"/approve".length));
      try {
        await queue.approve(taskId);
        return send(res, 200, { ok: true, task: queue.get(taskId) });
      } catch (e) {
        return send(res, 400, { error: (e as Error).message });
      }
    }
    if (method === "POST" && path.startsWith("/api/tasks/") && path.endsWith("/reject")) {
      const taskId = decodeURIComponent(path.slice("/api/tasks/".length, -"/reject".length));
      try {
        queue.reject(taskId);
        return send(res, 200, { ok: true, task: queue.get(taskId) });
      } catch (e) {
        return send(res, 400, { error: (e as Error).message });
      }
    }

    if (method === "GET" && path === "/api/status") {
      const readiness = await checkReadiness(process.env);
      const credentials = vault.list().filter((k) => k.startsWith(CRED_PREFIX)).length;
      return send(res, 200, { ...readiness, credentials });
    }

    if (method === "POST" && path === "/api/cycle") {
      // Same isAutomationRunning guard as the chat "run today's cycle"
      // command — see that call site for why (codebase.heal does real git
      // commits; two concurrent cycles risk a git index-lock collision).
      if (isAutomationRunning) return send(res, 409, { error: "a cycle is already running (automation loop or another manual trigger) — wait for it to finish" });
      const a = await ensureAtlas();
      isAutomationRunning = true;
      try {
        const report = await a.invoke("orchestrator", { op: "runDailyCycle", videoRef: null });
        return send(res, 200, report);
      } finally {
        isAutomationRunning = false;
      }
    }

    if (method === "POST" && path === "/api/learn") {
      const { url } = await readBody(req);
      if (!url) return send(res, 400, { error: "url required" });
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("web", { op: "learn", url: String(url) }));
    }

    if (method === "POST" && path === "/api/repo") {
      const { repo } = await readBody(req);
      if (!repo) return send(res, 400, { error: "repo required (owner/name)" });
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("web", { op: "repo", repo: String(repo) }));
    }

    if (method === "POST" && path === "/api/learn/bulk") {
      const { text } = await readBody(req);
      const urls = parseUrls(String(text ?? "")).slice(0, 25);
      const a = await ensureAtlas();
      const results: Array<{ url: string; ok: boolean; title?: string; error?: string }> = [];
      for (const url of urls) {
        try {
          const r = (await a.invoke("web", { op: "learn", url })) as { title: string };
          results.push({ url, ok: true, title: r.title });
        } catch (e) {
          results.push({ url, ok: false, error: (e as Error).message });
        }
      }
      return send(res, 200, { total: urls.length, results });
    }

    if (method === "GET" && path === "/api/businesses") {
      const a = await ensureAtlas();
      return send(res, 200, { businesses: await a.invoke("business", { op: "listBusinesses" }) });
    }
    if (method === "POST" && path === "/api/businesses") {
      const { name, url, goal } = await readBody(req);
      if (!name) return send(res, 400, { error: "name required" });
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("business", { op: "add", business: { name, url, goal } }));
    }
    const bizResearch = path.match(/^\/api\/businesses\/([^/]+)\/research$/);
    if (method === "POST" && bizResearch) {
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("business", { op: "research", id: decodeURIComponent(bizResearch[1]!) }));
    }

    if (method === "GET" && path === "/api/gigs") {
      const a = await ensureAtlas();
      const status = url.searchParams.get("status") || undefined;
      return send(res, 200, { jobs: await a.invoke("gigfinder", { op: "list", status }) });
    }
    if (method === "GET" && path === "/api/gigs/stats") {
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("gigfinder", { op: "stats" }));
    }
    if (method === "POST" && path === "/api/gigs/search") {
      const { sources } = await readBody(req);
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("gigfinder", { op: "search", sources }));
    }
    const gigApprove = path.match(/^\/api\/gigs\/([^/]+)\/approve$/);
    if (method === "POST" && gigApprove) {
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("gigfinder", { op: "approve", id: decodeURIComponent(gigApprove[1]!) }));
    }
    const gigReject = path.match(/^\/api\/gigs\/([^/]+)\/reject$/);
    if (method === "POST" && gigReject) {
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("gigfinder", { op: "reject", id: decodeURIComponent(gigReject[1]!) }));
    }
    const gigSubmitted = path.match(/^\/api\/gigs\/([^/]+)\/submitted$/);
    if (method === "POST" && gigSubmitted) {
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("gigfinder", { op: "markSubmitted", id: decodeURIComponent(gigSubmitted[1]!) }));
    }
    const gigStatus = path.match(/^\/api\/gigs\/([^/]+)\/status$/);
    if (method === "POST" && gigStatus) {
      const { status, paidAmount } = await readBody(req);
      if (!status) return send(res, 400, { error: "status required" });
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("gigfinder", { op: "updateStatus", id: decodeURIComponent(gigStatus[1]!), status, paidAmount }));
    }

    if (method === "GET" && path === "/api/kdp/status") {
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("kdp", { op: "status" }));
    }
    if (method === "POST" && path === "/api/kdp/scan") {
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("kdp", { op: "scan" }));
    }
    if (method === "POST" && path === "/api/kdp/generate") {
      const { limit } = await readBody(req);
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("kdp", { op: "generate", limit }));
    }
    const kdpMark = path.match(/^\/api\/kdp\/books\/([^/]+)\/status$/);
    if (method === "POST" && kdpMark) {
      const { status, amazonUrl, amazonAsin } = await readBody(req);
      if (!status) return send(res, 400, { error: "status required" });
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("kdp", { op: "markStatus", id: decodeURIComponent(kdpMark[1]!), status, amazonUrl, amazonAsin }));
    }
    const kdpZip = path.match(/^\/api\/kdp\/books\/([^/]+)\/zip$/);
    if (method === "GET" && kdpZip) {
      const a = await ensureAtlas();
      const { filename, base64 } = (await a.invoke("kdp", { op: "downloadZip", id: decodeURIComponent(kdpZip[1]!) })) as { filename: string; base64: string };
      const buf = Buffer.from(base64, "base64");
      res.writeHead(200, { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${filename}"`, "Content-Length": buf.length });
      res.end(buf);
      return;
    }

    const kdpUpload = path.match(/^\/api\/kdp\/books\/([^/]+)\/upload$/);
    if (method === "POST" && kdpUpload) {
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("kdp", { op: "uploadToAmazon", id: decodeURIComponent(kdpUpload[1]!) }));
    }

    // ── Unified Morning Brief (aggregates pending items across every business) ──
    if (method === "GET" && path === "/api/brief") {
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("brief", { op: "today" }));
    }
    // Send (or test-send) the morning digest to Mat's phone right now.
    if (method === "POST" && path === "/api/brief/send") {
      const base = process.env.ATLAS_PUBLIC_URL || `https://${req.headers.host ?? "atlas.evervibesdigital.com"}`;
      try {
        return send(res, 200, await sendBriefDigest(base));
      } catch (e) {
        return send(res, 500, { error: (e as Error).message });
      }
    }
    // Bulk approve/reject a whole tier in one call — the "approve all emails"
    // button. Matched BEFORE the generic /:source/:id route below so
    // "/api/brief/bulk" isn't mistaken for a source+id pair. Default tier
    // "bulk" (outbound emails etc.); optionally scope to one source.
    if (method === "POST" && path === "/api/brief/bulk") {
      const { action, tier, source } = await readBody(req);
      if (action !== "approve" && action !== "reject") return send(res, 400, { error: "action must be 'approve' or 'reject'" });
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("brief", { op: "actBulk", action, tier: tier ?? "bulk", source: source || undefined }));
    }
    const briefAct = path.match(/^\/api\/brief\/([^/]+)\/([^/]+)$/);
    if (method === "POST" && briefAct) {
      const source = decodeURIComponent(briefAct[1]!);
      const id = decodeURIComponent(briefAct[2]!);
      const { action } = await readBody(req);
      if (action !== "approve" && action !== "reject") return send(res, 400, { error: "action must be 'approve' or 'reject'" });
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("brief", { op: "act", source, id, action }));
    }

    // ── Vitals (ATLAS's self-assessment: output / growth / learning) ──
    if (method === "GET" && path === "/api/vitals") {
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("vitals", { op: "check" }));
    }

    // ── Outreach (bridges compliance + wholesale n8n workflows) ──
    if (method === "GET" && path === "/api/outreach/workflows") {
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("outreach", { op: "listWorkflows" }));
    }
    if (method === "POST" && path === "/api/outreach/notify") {
      const { target, payload } = await readBody(req);
      if (!target || !payload) return send(res, 400, { error: "target and payload required" });
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("outreach", { op: "notify", target, payload }));
    }
    const outreachActive = path.match(/^\/api\/outreach\/workflows\/([^/]+)\/active$/);
    if (method === "POST" && outreachActive) {
      const { active } = await readBody(req);
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("outreach", { op: "setActive", id: decodeURIComponent(outreachActive[1]!), active: Boolean(active) }));
    }

    // ── Surplus Funds Platform (orchestrates Mat's Twin agents) ──
    if (method === "GET" && path === "/api/surplus/status") {
      const a = await ensureAtlas();
      const [agents, schedules] = await Promise.all([
        a.invoke("surplus", { op: "listAgents" }),
        a.invoke("surplus", { op: "schedules" }),
      ]);
      return send(res, 200, { ...(agents as object), ...(schedules as object) });
    }
    if (method === "POST" && path === "/api/surplus/run") {
      const { role, message } = await readBody(req);
      if (!role) return send(res, 400, { error: "role required (e.g. 'scraper', 'county-discovery', 'enricher')" });
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("surplus", { op: "run", role, message }));
    }
    if (method === "GET" && path === "/api/surplus/blueprint") {
      const role = new URL(req.url ?? "", "http://x").searchParams.get("role") ?? "scraper";
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("surplus", { op: "blueprint", role }));
    }
    if (method === "GET" && path === "/api/surplus/run-events") {
      const q = new URL(req.url ?? "", "http://x").searchParams;
      const role = q.get("role");
      const runId = q.get("runId");
      if (!role || !runId) return send(res, 400, { error: "role and runId required" });
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("surplus", { op: "runEvents", role, runId }));
    }
    if (method === "POST" && path === "/api/surplus/pause") {
      const { role } = await readBody(req);
      if (!role) return send(res, 400, { error: "role required" });
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("surplus", { op: "pause", role: String(role) }));
    }
    // Renders one surplus letter/email for review. Sends nothing — the point is
    // to read the exact wording before a real homeowner ever sees it.
    if (method === "POST" && path === "/api/surplus/draft-outreach") {
      const b = await readBody(req);
      if (!b?.lead) return send(res, 400, { error: "lead required" });
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("surplus", {
        op: "draftOutreach",
        lead: b.lead,
        channel: b.channel === "email" ? "email" : "letter",
        feePercent: b.feePercent,
        senderName: b.senderName,
        companyName: b.companyName,
        companyAddress: b.companyAddress,
        contactPhone: b.contactPhone,
        contactEmail: b.contactEmail,
      }));
    }

    // ── Enrichment (skip-tracing via Twin — costs real money) ──
    if (method === "POST" && path === "/api/enrichment/preview") {
      const { targets } = await readBody(req);
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("enrichment", { op: "preview", targets: targets ?? [] }));
    }
    // `confirmCost` is passed straight through, never defaulted. The plugin
    // refuses without a literal true, so no caller — including a future
    // autonomous cycle — can spend money by omission.
    if (method === "POST" && path === "/api/enrichment/enrich") {
      const { targets, confirmCost } = await readBody(req);
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("enrichment", { op: "enrich", targets: targets ?? [], confirmCost }));
    }

    // ── Wholesale (buyer list, intro drafts, sending) ──
    if (method === "GET" && path === "/api/wholesale/buyer-stats") {
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("wholesale", { op: "buyerStats" }));
    }
    if (method === "GET" && path === "/api/wholesale/buyers") {
      const q = new URL(req.url ?? "", "http://x").searchParams;
      const limitRaw = q.get("limit");
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("wholesale", {
        op: "listBuyers",
        mailableOnly: q.get("mailable") === "1",
        limit: limitRaw ? Number(limitRaw) : undefined,
      }));
    }
    if (method === "POST" && path === "/api/wholesale/trace-buyers") {
      const { count, dryRun, confirmSpend } = await readBody(req);
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("wholesale", {
        op: "traceTopBuyers",
        count: count === undefined ? undefined : Number(count),
        dryRun,
        confirmSpend,
      }));
    }
    if (method === "POST" && path === "/api/wholesale/preview-intros") {
      const { max } = await readBody(req);
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("wholesale", { op: "previewIntros", max: max === undefined ? undefined : Number(max) }));
    }
    if (method === "POST" && path === "/api/wholesale/send-intros") {
      const { max, drafts, confirmSend } = await readBody(req);
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("wholesale", {
        op: "sendIntros",
        max: max === undefined ? undefined : Number(max),
        drafts,
        confirmSend,
      }));
    }
    const wholesaleVeto = path.match(/^\/api\/wholesale\/pending\/([^/]+)\/veto$/);
    if (method === "POST" && wholesaleVeto) {
      const { reason } = await readBody(req);
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("wholesale", { op: "veto", id: decodeURIComponent(wholesaleVeto[1]!), reason }));
    }
    const wholesaleDiscard = path.match(/^\/api\/wholesale\/intro-drafts\/([^/]+)$/);
    if (method === "DELETE" && wholesaleDiscard) {
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("wholesale", { op: "discardIntroDraft", id: decodeURIComponent(wholesaleDiscard[1]!) }));
    }

    // ── Leadscan (website-compliance business) ──
    if (method === "POST" && path === "/api/leadscan/scan") {
      const { url: target } = await readBody(req);
      if (!target) return send(res, 400, { error: "url required" });
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("leadscan", { op: "scan", url: String(target) }));
    }
    if (method === "POST" && path === "/api/leadscan/find") {
      const { niche, city } = await readBody(req);
      if (!niche || !city) return send(res, 400, { error: "niche and city required" });
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("leadscan", { op: "findLeads", niche: String(niche), city: String(city) }));
    }
    if (method === "GET" && path === "/api/leadscan/leads") {
      const status = new URL(req.url ?? "", "http://x").searchParams.get("status") ?? undefined;
      const a = await ensureAtlas();
      return send(res, 200, { leads: await a.invoke("leadscan", { op: "list", status }) });
    }
    if (method === "POST" && path === "/api/leadscan/draft-outreach") {
      const b = await readBody(req);
      if (!b?.id) return send(res, 400, { error: "id required" });
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("leadscan", {
        op: "draftOutreach",
        id: String(b.id),
        senderName: b.senderName,
        companyName: b.companyName,
        companyAddress: b.companyAddress,
        startingPrice: b.startingPrice,
      }));
    }
    // Drafts cold outreach for a batch of leads in the exact shape /api/sender
    // takes, so the panel can go draft -> preview -> send with no reshaping.
    if (method === "POST" && path === "/api/leadscan/draft-batch") {
      const { ids, startingPrice } = await readBody(req);
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("leadscan", { op: "draftBatch", ids, startingPrice }));
    }
    // Marks contacted after a REAL send. Not /approve — that one fires the n8n
    // new-lead confirmation, which would be a second, wrong email.
    if (method === "POST" && path === "/api/leadscan/mark-sent") {
      const { id } = await readBody(req);
      if (!id) return send(res, 400, { error: "id required" });
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("leadscan", { op: "markSent", id: String(id) }));
    }
    const leadDecision = path.match(/^\/api\/leadscan\/leads\/([^/]+)\/(approve|reject)$/);
    if (method === "POST" && leadDecision) {
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("leadscan", {
        op: leadDecision[2] as "approve" | "reject",
        id: decodeURIComponent(leadDecision[1]!),
      }));
    }

    // Scopes a won gig into a work package + paste-ready handoff prompt.
    const gigPlan = path.match(/^\/api\/gigs\/([^/]+)\/plan-work$/);
    if (method === "POST" && gigPlan) {
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("gigfinder", { op: "planWork", id: decodeURIComponent(gigPlan[1]!) }));
    }

    // ── Sender: the single path email leaves ATLAS by ──
    if (method === "GET" && path === "/api/sender/status") {
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("sender", { op: "status" }));
    }
    if (method === "POST" && path === "/api/sender/preview") {
      const { emails } = await readBody(req);
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("sender", { op: "preview", emails: emails ?? [] }));
    }
    // `confirmSend` is passed through untouched, never defaulted — the plugin
    // refuses without a literal true, and that refusal is the whole safety
    // model. Defaulting it here would quietly remove it.
    if (method === "POST" && path === "/api/sender/send") {
      const { emails, confirmSend, replyTo } = await readBody(req);
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("sender", { op: "send", emails: emails ?? [], confirmSend, replyTo }));
    }
    if (method === "GET" && path === "/api/sender/suppressed") {
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("sender", { op: "listSuppressed" }));
    }
    if (method === "POST" && path === "/api/sender/suppress") {
      const { email, reason } = await readBody(req);
      if (!email) return send(res, 400, { error: "email required" });
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("sender", { op: "suppress", email: String(email), reason }));
    }

    // ── Engineering intake: a one-line request → a paste-ready brief naming
    // the files that matter. Fully deterministic, so it still works when the
    // AI quota is gone.
    if (method === "POST" && path === "/api/engineering/plan-work") {
      const { title, description, limit } = await readBody(req);
      if (!title) return send(res, 400, { error: "title required" });
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("engineering", {
        op: "planWork",
        task: { title: String(title), description: description ? String(description) : undefined },
        limit: limit === undefined ? undefined : Number(limit),
      }));
    }
    if (method === "POST" && path === "/api/engineering/classify") {
      const { title, description } = await readBody(req);
      if (!title) return send(res, 400, { error: "title required" });
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("engineering", {
        op: "classify",
        task: { title: String(title), description: description ? String(description) : undefined },
      }));
    }
    if (method === "POST" && path === "/api/engineering/audit") {
      const { dir } = await readBody(req);
      if (!dir) return send(res, 400, { error: "dir required" });
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("engineering", { op: "audit", dir: String(dir) }));
    }

    if (method === "POST" && path === "/api/codebase") {
      const { dir, name } = await readBody(req);
      if (!dir) return send(res, 400, { error: "dir (folder path) required" });
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("codebase", { op: "learn", dir: String(dir), name }));
    }

    if (method === "GET" && path === "/api/tools") {
      const a = await ensureAtlas();
      return send(res, 200, { tools: await a.invoke("toolvault", { op: "list" }) });
    }
    if (method === "POST" && path === "/api/tools") {
      const b = await readBody(req);
      if (!b.name || !b.category) return send(res, 400, { error: "name and category required" });
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("toolvault", { op: "add", tool: { name: b.name, category: b.category, url: b.url, quality: Number(b.quality ?? 3), free: !!b.free, approved: !!b.approved, monthlyCost: b.monthlyCost ? Number(b.monthlyCost) : undefined, notes: b.notes } }));
    }
    const toolApprove = path.match(/^\/api\/tools\/([^/]+)\/approve$/);
    if (method === "POST" && toolApprove) {
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("toolvault", { op: "approve", id: decodeURIComponent(toolApprove[1]!) }));
    }

    const connSync = path.match(/^\/api\/connectors\/(github|vercel|supabase)\/sync$/);
    if (method === "POST" && connSync) {
      const which = connSync[1] as "github" | "vercel" | "supabase";
      const tokenKey = { github: "GITHUB_TOKEN", vercel: "VERCEL_TOKEN", supabase: "SUPABASE_TOKEN" }[which];
      const token = vault.list().includes(tokenKey) ? vault.get(tokenKey) : undefined;
      if (!token) return send(res, 400, { error: `no ${tokenKey} saved — add it in the Connectors tab` });
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("connectors", { op: "sync", which, token }));
    }

    if (method === "POST" && path === "/api/inbox/check") {
      const { repo } = await readBody(req);
      const token = vault.list().includes("GITHUB_TOKEN") ? vault.get("GITHUB_TOKEN") : undefined;
      if (!token) return send(res, 400, { error: "no GITHUB_TOKEN saved — add it in the Connectors tab" });
      if (!repo) return send(res, 400, { error: "repo required (owner/name)" });
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("inbox", { op: "check", repo: String(repo), token }));
    }

    if (method === "POST" && path === "/api/import-history") {
      const { dir } = await readBody(req);
      if (!dir) return send(res, 400, { error: "dir required" });
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("codebase", { op: "importChats", dir: String(dir) }));
    }

    if (method === "GET" && path === "/api/skills") {
      const a = await ensureAtlas();
      return send(res, 200, { skills: await a.invoke("skills", { op: "list" }) });
    }
    if (method === "POST" && path === "/api/skills") {
      const { name, category, purpose } = await readBody(req);
      if (!name || !purpose) return send(res, 400, { error: "name and purpose required" });
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("skills", { op: "create", name, category, purpose }));
    }
    const skillRun = path.match(/^\/api\/skills\/([^/]+)\/run$/);
    if (method === "POST" && skillRun) {
      const { input } = await readBody(req);
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("skills", { op: "run", id: decodeURIComponent(skillRun[1]!), input: String(input ?? "") }));
    }

    if (method === "GET" && path === "/api/forge") {
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("forge", { op: "list" }));
    }
    if (method === "POST" && path === "/api/forge/draft") {
      const { name, capability, purpose } = await readBody(req);
      if (!name || !purpose) return send(res, 400, { error: "name and purpose required" });
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("forge", { op: "draft", name, capability, purpose }));
    }
    if (method === "POST" && path === "/api/forge/verify") {
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("forge", { op: "verify" }));
    }
    if (method === "POST" && path === "/api/forge/activate") {
      const { name } = await readBody(req);
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("forge", { op: "activate", name }));
    }

    if (method === "GET" && path === "/api/map") {
      const a = await ensureAtlas();
      const businesses = (await a.invoke("business", { op: "listBusinesses" })) as Array<{ name: string }>;
      return send(res, 200, { agents: a.loaded(), businesses: businesses.map((b) => b.name) });
    }

    if (method === "GET" && path === "/api/runs") {
      if (!authed(req)) return send(res, 401, { error: "locked — unlock first" });
      const a = await ensureAtlas();
      const params = new URL(req.url ?? "", "http://x").searchParams;
      const filter = {
        actor: params.get("agent") ?? undefined,
        status: (params.get("status") as "running" | "done" | "failed" | null) ?? undefined,
        since: params.get("since") ?? undefined,
        until: params.get("until") ?? undefined,
      };
      const limit = Number(params.get("limit") ?? 50);
      const runs = (await a.audit.query(filter))
        .filter((e) => e.status) // only entries that represent a trackable run, not one-off log lines
        .slice(-limit)
        .reverse(); // most recent first, matching /api/chats' existing convention
      return send(res, 200, { runs });
    }

    if (method === "GET" && path === "/api/actions") {
      const a = await ensureAtlas();
      return send(res, 200, { actions: await a.invoke("actions", { op: "list" }) });
    }
    if (method === "POST" && path === "/api/action") {
      const { type, title, target, detail } = await readBody(req);
      if (!title) return send(res, 400, { error: "title required" });
      const a = await ensureAtlas();
      return send(res, 200, await a.invoke("actions", { op: "request", request: { type: type ?? "custom", title, target, detail } }));
    }

    if (method === "GET" && path === "/api/approvals") {
      const a = await ensureAtlas();
      const pending = await a.invoke("approvals", { op: "list", status: "pending" });
      return send(res, 200, { pending });
    }

    const decision = path.match(/^\/api\/approvals\/([^/]+)\/(approve|reject)$/);
    if (method === "POST" && decision) {
      const a = await ensureAtlas();
      const result = await a.invoke("approvals", { op: decision[2] as "approve" | "reject", id: decodeURIComponent(decision[1]!) });
      return send(res, 200, { result });
    }

    return send(res, 404, { error: "not found" });
  }

  const server = httpCreateServer((req, res) => {
    handle(req, res).catch((e) => send(res, 500, { error: (e as Error).message }));
  });

  return {
    server,
    listen(port, host = "127.0.0.1") {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          const addr = server.address();
          resolve(typeof addr === "object" && addr ? addr.port : port);
        });
      });
    },
    async close(): Promise<void> {
      if (briefTimer) clearInterval(briefTimer);
      if (automationIntervalId) clearInterval(automationIntervalId);
      if (pendingRebuild) await pendingRebuild;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
