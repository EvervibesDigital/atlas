import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlPanel, type ControlPanel } from "../src/server";

let dir = "";
let panel: ControlPanel | null = null;
let base = "";

async function start(): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), "atlas-server-"));
  panel = createControlPanel({ vaultFile: join(dir, "vault.enc.json"), dataDir: dir });
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

  it("rejects the wrong master password on unlock", async () => {
    await start();
    await post("/api/setup", { masterPassword: "the-right-one" });
    await (await post("/api/lock", {}, undefined)); // no token → 401, fine; vault still initialized
    const bad = await post("/api/unlock", { masterPassword: "the-wrong-one" });
    expect(bad.status).toBe(401);
  });
});
