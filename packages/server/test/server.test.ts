import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { StubAdapter } from "@atlas/brain";
import { createControlPanel, formatIntentResult, type ControlPanel } from "../src/server";

/** Build a brief magic-link token the same way the server signs one. */
function mkBriefToken(secret: string, ttlMs = 3_600_000): string {
  const exp = Date.now() + ttlMs;
  const sig = createHmac("sha256", secret).update(`brief:${exp}`).digest("hex");
  return `${exp}.${sig}`;
}

let dir = "";
let panel: ControlPanel | null = null;
let base = "";

async function start(): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), "atlas-server-"));
  panel = createControlPanel({ vaultFile: join(dir, "vault.enc.json"), dataDir: dir, envFile: join(dir, ".env"), brainAdapters: [new StubAdapter()], healEnabled: false });
  const port = await panel.listen(0);
  base = `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  if (panel) await panel.close();
  panel = null;
  if (dir) await rm(dir, { recursive: true, force: true });
});

const post = (p: string, body: unknown, token?: string) =>
  fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { "x-atlas-token": token } : {}) }, body: JSON.stringify(body) });
const get = (p: string, token?: string) => fetch(base + p, { headers: token ? { "x-atlas-token": token } : {} });

describe("control panel", () => {
  it("serves the HTML page", async () => {
    await start();
    const r = await get("/");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("ATLAS Control Panel");
  });

  it("blocks protected routes until unlocked", async () => {
    await start();
    expect((await get("/api/secrets")).status).toBe(401);
  });

  it("lets a service token read GET /api/brief without a session, but nothing else", async () => {
    const prev = process.env.ATLAS_SERVICE_TOKEN;
    process.env.ATLAS_SERVICE_TOKEN = "svc-test-token";
    try {
      await start();
      const withHeader = (p: string, svcToken: string) => fetch(base + p, { headers: { "x-atlas-service-token": svcToken } });

      const ok = await withHeader("/api/brief", "svc-test-token");
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { items: unknown[]; count: number };
      expect(Array.isArray(body.items)).toBe(true);

      // Wrong token still denied.
      expect((await withHeader("/api/brief", "wrong-token")).status).toBe(401);
      // The service token grants nothing beyond this one read-only endpoint.
      expect((await withHeader("/api/secrets", "svc-test-token")).status).toBe(401);
      expect((await fetch(base + "/api/brief/kdp/book-1", { method: "POST", headers: { "x-atlas-service-token": "svc-test-token", "Content-Type": "application/json" }, body: JSON.stringify({ action: "approve" }) })).status).toBe(401);
    } finally {
      if (prev === undefined) delete process.env.ATLAS_SERVICE_TOKEN;
      else process.env.ATLAS_SERVICE_TOKEN = prev;
    }
  });

  it("sets up a vault, stores a key, and never leaks its value", async () => {
    await start();
    const setup = (await (await post("/api/setup", { masterPassword: "master-passphrase" })).json()) as { token: string };
    expect(setup.token).toBeTruthy();

    const save = await post("/api/secrets", { name: "GROQ_API_KEY", value: "gsk_supersecret" }, setup.token);
    expect(save.status).toBe(200);

    const list = (await (await get("/api/secrets", setup.token)).json()) as { providers: Record<string, boolean> };
    expect(list.providers.GROQ_API_KEY).toBe(true);
    // The secret VALUE must never come back over the wire.
    expect(JSON.stringify(list)).not.toContain("gsk_supersecret");
  });

  it("stores a platform login but never returns the password", async () => {
    await start();
    const { token } = (await (await post("/api/setup", { masterPassword: "master-passphrase" })).json()) as { token: string };
    await post("/api/credentials", { platform: "instagram", username: "everspark", password: "hunter2", notes: "" }, token);

    const creds = (await (await get("/api/credentials", token)).json()) as { credentials: Array<{ platform: string; username: string }> };
    expect(creds.credentials[0]!.platform).toBe("instagram");
    expect(creds.credentials[0]!.username).toBe("everspark");
    expect(JSON.stringify(creds)).not.toContain("hunter2");
  });

  it("chats with the brain and reports which model answered", async () => {
    await start();
    const { token } = (await (await post("/api/setup", { masterPassword: "master-passphrase" })).json()) as { token: string };
    const r = await post("/api/chat", { message: "hello ATLAS", history: [] }, token);
    expect(r.status).toBe(200);
    const data = (await r.json()) as { reply: string; provider: string };
    expect(data.reply.length).toBeGreaterThan(0);
    expect(data.provider).toBeTruthy(); // offline test env → the stub answers
  });

  it("blocks chat when locked", async () => {
    await start();
    expect((await post("/api/chat", { message: "hi" })).status).toBe(401);
  });

  it("exports provider keys to .env for overnight runs", async () => {
    await start();
    const { token } = (await (await post("/api/setup", { masterPassword: "master-passphrase" })).json()) as { token: string };
    await post("/api/secrets", { name: "GROQ_API_KEY", value: "gsk_night_key" }, token);

    const r = (await (await post("/api/export-env", {}, token)).json()) as { exported: number };
    expect(r.exported).toBe(1);

    const { readFile } = await import("node:fs/promises");
    const env = await readFile(join(dir, ".env"), "utf8");
    expect(env).toContain("GROQ_API_KEY=gsk_night_key");
  });

  it("locks out after too many failed unlock attempts (brute-force guard)", async () => {
    dir = await mkdtemp(join(tmpdir(), "atlas-server-"));
    panel = createControlPanel({ vaultFile: join(dir, "vault.enc.json"), dataDir: dir, envFile: join(dir, ".env"), maxUnlockFails: 3, lockoutMs: 60000 });
    const port = await panel.listen(0);
    base = `http://127.0.0.1:${port}`;

    await post("/api/setup", { masterPassword: "the-real-password" });
    // Lock first so unlock is the path being tested.
    // 3 wrong attempts trip the lockout.
    for (let i = 0; i < 3; i++) {
      const r = await post("/api/unlock", { masterPassword: "wrong" });
      expect(r.status).toBe(401);
    }
    // Now even the CORRECT password is refused with 429 during lockout.
    const locked = await post("/api/unlock", { masterPassword: "the-real-password" });
    expect(locked.status).toBe(429);
  });

  it("auto-unlocks on boot from ATLAS_MASTER_PASSWORD, surviving a restart with no manual /api/unlock call", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "atlas-server-autounlock-"));
    const vaultFile = join(tmp, "vault.enc.json");
    try {
      // "Boot 1" — a normal setup, as if Mat ran this once by hand.
      const first = createControlPanel({ vaultFile, dataDir: tmp, envFile: join(tmp, ".env"), brainAdapters: [new StubAdapter()], healEnabled: false });
      const port1 = await first.listen(0);
      await fetch(`http://127.0.0.1:${port1}/api/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ masterPassword: "restart-survives-this" }),
      });
      await first.close();

      // "Boot 2" — simulates a container restart: fresh process, same vault
      // file on disk, ATLAS_MASTER_PASSWORD set as it would be in the VPS's
      // docker-compose env. No /api/unlock call is ever made here.
      const prevEnv = process.env.ATLAS_MASTER_PASSWORD;
      process.env.ATLAS_MASTER_PASSWORD = "restart-survives-this";
      let second: ControlPanel | null = null;
      try {
        second = createControlPanel({ vaultFile, dataDir: tmp, envFile: join(tmp, ".env"), brainAdapters: [new StubAdapter()], healEnabled: false });
        const port2 = await second.listen(0);
        const base2 = `http://127.0.0.1:${port2}`;

        // Auto-unlock runs fire-and-forget off the event loop — poll instead
        // of assuming it's done by the time listen() resolves.
        let unlocked = false;
        for (let i = 0; i < 40; i++) {
          const h = (await (await fetch(`${base2}/api/health`)).json()) as { unlocked: boolean };
          if (h.unlocked) { unlocked = true; break; }
          await new Promise((r) => setTimeout(r, 25));
        }
        expect(unlocked).toBe(true);
      } finally {
        if (second) await second.close();
        if (prevEnv === undefined) delete process.env.ATLAS_MASTER_PASSWORD;
        else process.env.ATLAS_MASTER_PASSWORD = prevEnv;
      }
    } finally {
      // maxRetries/retryDelay: on Windows, closing two panels against the
      // same vault file back-to-back can leave a file handle momentarily
      // held past close() resolving — Node's own built-in retry (undocumented
      // default is 0) absorbs that instead of flaking the test.
      await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("does not auto-unlock, and does not error, when ATLAS_MASTER_PASSWORD isn't set (existing local/dev behavior)", async () => {
    const prevEnv = process.env.ATLAS_MASTER_PASSWORD;
    delete process.env.ATLAS_MASTER_PASSWORD;
    try {
      await start();
      const { token } = (await (await post("/api/setup", { masterPassword: "some-password" })).json()) as { token: string };
      await post("/api/lock", {}, token);
      const h = (await (await get("/api/health")).json()) as { unlocked: boolean };
      expect(h.unlocked).toBe(false);
    } finally {
      if (prevEnv !== undefined) process.env.ATLAS_MASTER_PASSWORD = prevEnv;
    }
  });

  it("serves the phone brief + its API to a valid magic-link token, and rejects a bad one", async () => {
    process.env.ATLAS_LINK_SECRET = "test-link-secret";
    try {
      await start();
      await post("/api/setup", { masterPassword: "pw-for-brief" });
      const tok = mkBriefToken("test-link-secret");

      // API reachable WITH a valid token (no session), returns the brief shape.
      const ok = await fetch(base + "/api/brief", { headers: { "x-brief-token": tok } });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { items: unknown[]; count: number };
      expect(Array.isArray(body.items)).toBe(true);

      // A bad token gets no access — falls through to the session gate → 401.
      const bad = await fetch(base + "/api/brief", { headers: { "x-brief-token": "not.a.real.token" } });
      expect(bad.status).toBe(401);

      // The mobile page renders for a valid token…
      const page = await fetch(base + "/m?t=" + encodeURIComponent(tok));
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("Morning Brief");

      // …and shows the expired notice with no/invalid token.
      const expired = await fetch(base + "/m");
      expect(await expired.text()).toMatch(/expired/i);
    } finally {
      delete process.env.ATLAS_LINK_SECRET;
    }
  });

  it("rejects the wrong master password on unlock", async () => {
    await start();
    await post("/api/setup", { masterPassword: "the-right-one" });
    await (await post("/api/lock", {}, undefined)); // no token → 401, fine; vault still initialized
    const bad = await post("/api/unlock", { masterPassword: "the-wrong-one" });
    expect(bad.status).toBe(401);
  });

  it("GET /api/runs lists ledger entries, filterable by status", async () => {
    await start();
    const { token } = (await (await post("/api/setup", { masterPassword: "master-passphrase" })).json()) as { token: string };
    // The stub-brain chat call below goes through Atlas.invoke("brain", ...) and
    // Atlas.invoke("memory", ...) internally, which is enough to populate the ledger.
    await post("/api/chat", { message: "hello ATLAS", history: [] }, token);

    const res = await get("/api/runs?limit=50", token);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { runs: Array<{ status: string; actor: string }> };
    expect(Array.isArray(data.runs)).toBe(true);
    expect(data.runs.some((r) => r.actor === "owner-console" && r.status === "done")).toBe(true);

    const failedOnly = await get("/api/runs?status=failed", token);
    const failedData = (await failedOnly.json()) as { runs: unknown[] };
    expect(failedData.runs).toHaveLength(0); // nothing failed in this test run
  });

  it("blocks GET /api/runs when locked", async () => {
    await start();
    expect((await get("/api/runs")).status).toBe(401);
  });

  it("blocks a second /api/cycle from running while one is already in flight", async () => {
    await start();
    const { token } = (await (await post("/api/setup", { masterPassword: "master-passphrase" })).json()) as { token: string };
    // Fire two cycle requests essentially simultaneously — without the
    // isAutomationRunning guard threaded through /api/cycle, both would run
    // orchestrator.runDailyCycle concurrently in the same process.
    const [a, b] = await Promise.all([post("/api/cycle", {}, token), post("/api/cycle", {}, token)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const blocked = a.status === 409 ? a : b;
    const body = (await blocked.json()) as { error: string };
    expect(body.error).toMatch(/already running/i);
  }, 90000); // this file runs real (non-stubbed) cycles — one alone can take 17-35s here

  it("chat's cycle summary reports cycleHealth pass/fail counts", async () => {
    await start();
    const { token } = (await (await post("/api/setup", { masterPassword: "master-passphrase" })).json()) as { token: string };
    const r = await post("/api/chat", { message: "run today's cycle", history: [] }, token);
    expect(r.status).toBe(200);
    const data = (await r.json()) as { reply: string };
    // Either all-succeeded or some-failed phrasing must appear — this proves
    // formatIntentResult's "cycle" branch reads cycleHealth, not that any
    // particular outcome happens in this offline stub test environment.
    expect(data.reply).toMatch(/steps (succeeded|failed)/);
  }, 60000);

  it("formatIntentResult appends the self-heal line after the health line, without dropping or duplicating either", () => {
    const withHeal = formatIntentResult("cycle", {
      topic: "t",
      reel: { hook: "h" },
      pendingApprovals: [],
      cycleHealth: { succeeded: 5, failed: 0, failures: [] },
      healReport: { healed: 2, attempted: 3, total: 3 },
    });
    expect(withHeal).toContain("✅ All 5 steps succeeded.");
    expect(withHeal).toContain("🩹 Self-heal: fixed 2/3 code errors found this cycle.");
    // The heal line must come after the health line, and each must appear exactly once.
    expect(withHeal.indexOf("✅")).toBeLessThan(withHeal.indexOf("🩹"));
    expect(withHeal.match(/✅/g)).toHaveLength(1);
    expect(withHeal.match(/🩹/g)).toHaveLength(1);

    const withoutHeal = formatIntentResult("cycle", {
      topic: "t",
      reel: { hook: "h" },
      pendingApprovals: [],
      cycleHealth: { succeeded: 5, failed: 0, failures: [] },
    });
    expect(withoutHeal).toContain("✅ All 5 steps succeeded.");
    expect(withoutHeal).not.toContain("🩹");

    const zeroAttempted = formatIntentResult("cycle", {
      topic: "t",
      reel: { hook: "h" },
      pendingApprovals: [],
      cycleHealth: { succeeded: 5, failed: 0, failures: [] },
      healReport: { healed: 0, attempted: 0, total: 0 },
    });
    expect(zeroAttempted).not.toContain("🩹");
  });

  it("POST /api/cfo/forecast runs the forecast with Mat-supplied inputs", async () => {
    await start();
    const { token } = (await (await post("/api/setup", { masterPassword: "master-passphrase" })).json()) as { token: string };
    const r = await post("/api/cfo/forecast", { cashOnHand: 10000, monthlyRevenue: 4000, monthlyExpenses: 5000 }, token);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { netMonthly: number; runwayMonths: number | null; verdict: string };
    expect(body.netMonthly).toBe(-1000);
    expect(body.runwayMonths).toBe(10);
    expect(body.verdict).toBe("healthy");
  });

  it("POST /api/cfo/forecast rejects a missing required field", async () => {
    await start();
    const { token } = (await (await post("/api/setup", { masterPassword: "master-passphrase" })).json()) as { token: string };
    const r = await post("/api/cfo/forecast", { cashOnHand: 10000 }, token);
    expect(r.status).toBe(400);
  });

  it("POST /api/cfo/roi calculates ROI", async () => {
    await start();
    const { token } = (await (await post("/api/setup", { masterPassword: "master-passphrase" })).json()) as { token: string };
    const r = await post("/api/cfo/roi", { cost: 100, expectedReturn: 150 }, token);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { roi: number };
    expect(body.roi).toBe(0.5);
  });

  it("POST /api/cfo/roi rejects a missing required field", async () => {
    await start();
    const { token } = (await (await post("/api/setup", { masterPassword: "master-passphrase" })).json()) as { token: string };
    const r = await post("/api/cfo/roi", { cost: 100 }, token);
    expect(r.status).toBe(400);
  });

  it("POST /api/knowledge/playbook returns a playbook for a topic", async () => {
    await start();
    const { token } = (await (await post("/api/setup", { masterPassword: "master-passphrase" })).json()) as { token: string };
    const r = await post("/api/knowledge/playbook", { topic: "cold outreach" }, token);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { title: string; sections: unknown[] };
    expect(body.title).toBe("Playbook: cold outreach");
    expect(Array.isArray(body.sections)).toBe(true);
  });

  it("POST /api/knowledge/playbook rejects a missing topic", async () => {
    await start();
    const { token } = (await (await post("/api/setup", { masterPassword: "master-passphrase" })).json()) as { token: string };
    const r = await post("/api/knowledge/playbook", {}, token);
    expect(r.status).toBe(400);
  });

  it("POST /api/archaeologist/dig returns findings", async () => {
    await start();
    const { token } = (await (await post("/api/setup", { masterPassword: "master-passphrase" })).json()) as { token: string };
    const r = await post("/api/archaeologist/dig", { topic: "old ideas" }, token);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { findings: string };
    expect(typeof body.findings).toBe("string");
  });

  it("POST /api/archaeologist/dig works with no topic given", async () => {
    await start();
    const { token } = (await (await post("/api/setup", { masterPassword: "master-passphrase" })).json()) as { token: string };
    const r = await post("/api/archaeologist/dig", {}, token);
    expect(r.status).toBe(200);
  });
});
