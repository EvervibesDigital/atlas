import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StubAdapter } from "@atlas/brain";
import { createControlPanel, type ControlPanel } from "../src/server";

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
});
