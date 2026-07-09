import { createServer as httpCreateServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Atlas } from "@atlas/core";
import { buildAtlas, checkReadiness } from "@atlas/app";
import { Vault } from "@atlas/vault";
import { PAGE } from "./html";

const KNOWN_PROVIDERS = ["GROQ_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"];
const CRED_PREFIX = "cred:";

export interface ControlPanelOptions {
  vaultFile?: string;
  dataDir?: string;
  /** Where "Enable overnight runs" writes provider keys (default ./.env). */
  envFile?: string;
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
  const vault = new Vault(vaultFile);
  let token: string | null = null;
  let atlas: Atlas | null = null;

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
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
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
      const { masterPassword } = await readBody(req);
      try {
        await vault.unlock(String(masterPassword ?? ""));
      } catch (e) {
        return send(res, 401, { error: (e as Error).message });
      }
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
      const { message, history } = await readBody(req);
      if (!message) return send(res, 400, { error: "message required" });
      const a = await ensureAtlas();

      // Recall memories related to what Mat is asking (best-effort).
      let recalled = "";
      try {
        const hits = (await a.invoke("memory", { op: "search", query: String(message), options: { limit: 3, minScore: 0.15 } })) as Array<{
          record: { content: string };
        }>;
        if (hits.length) recalled = "Things you remember that may be relevant:\n" + hits.map((h) => `- ${h.record.content}`).join("\n");
      } catch {
        /* memory optional */
      }

      const turns = Array.isArray(history) ? (history as Array<{ role: string; text: string }>).slice(-10) : [];
      const convo = turns.map((t) => `${t.role === "user" ? "Mat" : "ATLAS"}: ${t.text}`).join("\n");

      const system = [
        "You are ATLAS — Mat's autonomous AI Operating System (AI That Learns, Acts & Scales).",
        "You run his businesses' agents: creative (Instagram Reels), publishing (approval-gated), CFO, strategy board, research, learning, and more.",
        "Mat is a non-technical founder; explain things plainly, be direct and practical, keep answers tight.",
        "You never post or spend money without Mat's approval. If asked to do something, explain what you'd queue and where he approves it (the Approvals tab).",
        "If you don't know something, say so honestly.",
      ].join(" ");

      const prompt = [recalled, convo, `Mat: ${String(message)}`, "ATLAS:"].filter(Boolean).join("\n\n");

      const started = Date.now();
      const resp = (await a.invoke("brain", {
        prompt,
        system,
        needs: { reasoning: 0.7, creativity: 0.4, cost: 1 },
        maxTokens: 1024,
        task: "owner.chat",
      })) as { text: string; provider: string; model: string };

      // Every conversation becomes memory — this is how chatting develops ATLAS.
      try {
        await a.invoke("memory", {
          op: "remember",
          input: {
            kind: "conversation",
            content: `Mat asked: ${String(message).slice(0, 300)} | ATLAS answered: ${resp.text.slice(0, 300)}`,
          },
        });
      } catch {
        /* memory optional */
      }

      return send(res, 200, { reply: resp.text, provider: resp.provider, model: resp.model, latencyMs: Date.now() - started });
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
      const kept = existing.split(/\r?\n/).filter((l) => l.trim() && !KNOWN_PROVIDERS.some((p) => l.startsWith(`${p}=`)));
      const exported: string[] = [];
      for (const p of KNOWN_PROVIDERS) {
        const val = vault.list().includes(p) ? vault.get(p) : undefined;
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
