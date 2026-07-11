import { createServer as httpCreateServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Atlas } from "@atlas/core";
import { buildAtlas, checkReadiness } from "@atlas/app";
import { Vault } from "@atlas/vault";
import { SessionStore } from "./sessions";
import { PAGE } from "./html";

const KNOWN_PROVIDERS = ["GROQ_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"];
const CRED_PREFIX = "cred:";

/**
 * Parse pasted key text into name/value pairs. Accepts many formats on separate
 * lines: `KEY=value`, `export KEY=value`, `KEY: value`, `KEY value`, optional
 * quotes; ignores blank lines and #/// comments.
 */
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
}
const KEY_SPECS: KeySpec[] = [
  { re: /sk-ant-[A-Za-z0-9_-]{20,}/g, name: "ANTHROPIC_API_KEY", label: "Anthropic", category: "llm", free: false, approved: true },
  { re: /sk-or-v1-[A-Za-z0-9]{20,}/g, name: "OPENROUTER_API_KEY", label: "OpenRouter", category: "llm", free: true },
  { re: /gsk_[A-Za-z0-9]{30,}/g, name: "GROQ_API_KEY", label: "Groq", category: "llm", free: true },
  { re: /AIza[A-Za-z0-9_-]{30,}/g, name: "GEMINI_API_KEY", label: "Google Gemini", category: "llm", free: true },
  { re: /sbp_[a-f0-9]{40}/g, name: "SUPABASE_TOKEN", label: "Supabase", category: "database", free: true },
  { re: /(?:ghp|github_pat)_[A-Za-z0-9_]{20,}/g, name: "GITHUB_TOKEN", label: "GitHub", category: "dev", free: true },
  { re: /(?:vck|vcp)_[A-Za-z0-9]{20,}/g, name: "VERCEL_TOKEN", label: "Vercel", category: "hosting", free: true },
  { re: /rk_live_[A-Za-z0-9]{20,}/g, name: "STRIPE_RESTRICTED_KEY", label: "Stripe (live)", category: "payments", free: true, sensitive: true },
  { re: /pk_live_[A-Za-z0-9]{20,}/g, name: "STRIPE_PUBLISHABLE_KEY", label: "Stripe (publishable)", category: "payments", free: true },
  { re: /re_[A-Za-z0-9_]{16,}/g, name: "RESEND_API_KEY", label: "Resend", category: "email", free: true },
  { re: /tvly-[A-Za-z0-9-]{16,}/g, name: "TAVILY_API_KEY", label: "Tavily", category: "search", free: true },
  { re: /apify_api_[A-Za-z0-9]{20,}/g, name: "APIFY_API_KEY", label: "Apify", category: "scraping", free: true },
  { re: /ph[xc]_[A-Za-z0-9]{20,}/g, name: "POSTHOG_API_KEY", label: "PostHog", category: "analytics", free: true },
  { re: /pina_[A-Za-z0-9]{30,}/g, name: "PINTEREST_TOKEN", label: "Pinterest", category: "posting", free: true },
  { re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, name: "SLACK_TOKEN", label: "Slack", category: "messaging", free: true },
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
  if (kind === "cycle") {
    const rep = r as { topic?: string; reel?: { hook?: string }; pendingApprovals?: unknown[] };
    return `Done. Topic: ${rep.topic}. Drafted hook: "${rep.reel?.hook ?? ""}". ${rep.pendingApprovals?.length ?? 0} item(s) awaiting your approval.`;
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
  const envFile = opts.envFile ?? "./.env";
  const maxUnlockFails = opts.maxUnlockFails ?? 5;
  const lockoutMs = opts.lockoutMs ?? 15 * 60 * 1000;
  const vault = new Vault(vaultFile);
  const sessions = new SessionStore(`${dataDir}/chats.json`);
  let token: string | null = null;
  let atlas: Atlas | null = null;
  let failedUnlocks = 0;
  let lockedUntil = 0;

  async function rebuildAtlas(): Promise<void> {
    if (vault.unlocked) {
      for (const k of vault.list()) {
        if (!k.startsWith(CRED_PREFIX)) {
          const val = vault.get(k);
          if (val) process.env[k] = val;
        }
      }
    }
    atlas = await buildAtlas({
      memoryFile: `${dataDir}/memory.json`,
      approvalsFile: `${dataDir}/approvals.json`,
      metricsFile: `${dataDir}/metrics.json`,
      businessFile: `${dataDir}/businesses.json`,
      toolVaultFile: `${dataDir}/toolvault.json`,
      skillsFile: `${dataDir}/skills.json`,
      forgeDir: "./forge",
    });
  }

  async function ensureAtlas(): Promise<Atlas> {
    if (!atlas) await rebuildAtlas();
    return atlas!;
  }

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

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "GET" && path === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store, must-revalidate" });
      res.end(PAGE);
      return;
    }

    if (method === "GET" && path === "/api/health") {
      return send(res, 200, { ok: true, initialized: await vault.exists(), unlocked: vault.unlocked });
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
      const { title, project } = await readBody(req);
      if (typeof title === "string") await sessions.rename(id, title);
      if (typeof project === "string") await sessions.setProject(id, project);
      const s = await sessions.get(id);
      return s ? send(res, 200, s) : send(res, 404, { error: "no such chat" });
    }
    if (method === "DELETE" && path.startsWith("/api/chats/")) {
      const id = decodeURIComponent(path.slice("/api/chats/".length));
      const ok = await sessions.remove(id);
      return send(res, ok ? 200 : 404, { ok });
    }

    if (method === "GET" && path === "/api/secrets") {
      const names = vault.list().filter((k) => !k.startsWith(CRED_PREFIX));
      const providers = Object.fromEntries(KNOWN_PROVIDERS.map((p) => [p, names.includes(p)]));
      return send(res, 200, { names, providers });
    }
    if (method === "POST" && path === "/api/secrets") {
      const { name, value } = await readBody(req);
      if (!name || !value) return send(res, 400, { error: "name and value required" });
      await vault.set(String(name), String(value));
      await rebuildAtlas();
      return send(res, 200, { ok: true });
    }
    if (method === "POST" && path === "/api/secrets/bulk") {
      const { text } = await readBody(req);
      const pairs = parseKeyLines(String(text ?? ""));
      for (const p of pairs) await vault.set(p.name, p.value);
      if (pairs.length) await rebuildAtlas();
      return send(res, 200, { saved: pairs.length, names: pairs.map((p) => p.name) });
    }
    if (method === "DELETE" && path.startsWith("/api/secrets/")) {
      const name = decodeURIComponent(path.slice("/api/secrets/".length));
      const ok = await vault.delete(name);
      await rebuildAtlas();
      return send(res, 200, { ok });
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

    if (method === "POST" && path === "/api/chat") {
      const { message, history, sessionId } = await readBody(req);
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
        try {
          const result = await a.invoke(intent.service, intent.payload);
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

      const system = [
        "You are ATLAS — Mat's autonomous AI Operating System (AI That Learns, Acts & Scales).",
        "You run his businesses' agents: creative (Instagram Reels), publishing (approval-gated), CFO, strategy board, research, learning, curiosity, red-team, and more.",
        "Mat is a non-technical founder; explain plainly, be direct and useful, and give complete answers (don't cut yourself off).",
        "You can DO things when asked: 'find free X apis', 'scout github for X', 'search for X', 'find the website for X', 'run today's cycle', 'red team: <idea>', 'learn <url>', 'give me ideas', 'business brief', 'check email'. If Mat seems to want an action, tell him the exact phrase to say.",
        "When [saved:NAME] placeholders appear, a secret was already stored securely in the vault — acknowledge it briefly, never ask for the value, and move on.",
        "You never post, spend money, sign up, or install without Mat's approval; explain what you'd queue and that he approves it in the Approvals tab.",
        "If you don't know something, say so honestly.",
      ].join(" ");

      const prompt = [recalled, convo, `Mat: ${safeMessage}`, "ATLAS:"].filter(Boolean).join("\n\n");

      const resp = (await a.invoke("brain", {
        prompt,
        system,
        needs: chatNeeds(safeMessage),
        maxTokens: 2048,
        task: "owner.chat",
      })) as { text: string; provider: string; model: string };

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

    if (method === "GET" && path === "/api/status") {
      const readiness = await checkReadiness(process.env);
      const credentials = vault.list().filter((k) => k.startsWith(CRED_PREFIX)).length;
      return send(res, 200, { ...readiness, credentials });
    }

    if (method === "POST" && path === "/api/cycle") {
      const a = await ensureAtlas();
      const report = await a.invoke("orchestrator", { op: "runDailyCycle", videoRef: null });
      return send(res, 200, report);
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
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
