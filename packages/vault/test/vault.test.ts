import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/index";

let dir = "";
async function tmpVault(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "atlas-vault-"));
  return join(dir, "vault.enc.json");
}
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("Vault", () => {
  it("initializes, stores, and retrieves a secret", async () => {
    const v = new Vault(await tmpVault());
    await v.initialize("correct horse battery");
    await v.set("GROQ_API_KEY", "gsk_secret_123");
    expect(v.get("GROQ_API_KEY")).toBe("gsk_secret_123");
  });

  it("rejects the wrong master password", async () => {
    const file = await tmpVault();
    await new Vault(file).initialize("the-right-password");

    const v2 = new Vault(file);
    await expect(v2.unlock("the-wrong-password")).rejects.toThrow(/incorrect master password/);
    expect(v2.unlocked).toBe(false);
  });

  it("persists encrypted across instances and unlocks with the right password", async () => {
    const file = await tmpVault();
    const v1 = new Vault(file);
    await v1.initialize("master-passphrase");
    await v1.set("OPENROUTER_API_KEY", "or_key");

    const v2 = new Vault(file);
    await v2.unlock("master-passphrase");
    expect(v2.get("OPENROUTER_API_KEY")).toBe("or_key");
  });

  it("lists names only and never plaintext values on disk", async () => {
    const file = await tmpVault();
    const v = new Vault(file);
    await v.initialize("master-passphrase");
    await v.set("SECRET", "super-sensitive-value");
    expect(v.list()).toEqual(["SECRET"]);

    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(file, "utf8");
    expect(raw).not.toContain("super-sensitive-value");
  });

  it("throws when used while locked", async () => {
    const v = new Vault(await tmpVault());
    await v.initialize("master-passphrase");
    v.lock();
    expect(() => v.list()).toThrow(/locked/);
  });
});
