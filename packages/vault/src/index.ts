import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Vault — an encrypted secrets store for ATLAS.
 *
 * API keys and platform logins are encrypted at rest with AES-256-GCM. The
 * encryption key is derived from a master password via scrypt, so the file is
 * useless to anyone without that password. Values are only ever decrypted in
 * memory after `unlock` — they are never written in the clear and the file is
 * git-ignored. There is deliberately no password recovery: forget it and the
 * secrets are gone.
 */

interface EncEntry {
  iv: string;
  ct: string;
  tag: string;
}

interface VaultFile {
  version: 1;
  salt: string;
  verifier: EncEntry;
  entries: Record<string, EncEntry>;
}

const VERIFIER_PLAINTEXT = "atlas-vault-verifier-v1";

export class Vault {
  private key: Buffer | null = null;
  private data: VaultFile | null = null;

  constructor(private file: string) {}

  private async read(): Promise<VaultFile | null> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as VaultFile;
    } catch {
      return null;
    }
  }

  private async persist(): Promise<void> {
    if (!this.data) return;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.data, null, 2), "utf8");
  }

  private deriveKey(password: string, salt: Buffer): Buffer {
    return scryptSync(password, salt, 32);
  }

  private encrypt(plaintext: string): EncEntry {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key!, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { iv: iv.toString("hex"), ct: ct.toString("hex"), tag: cipher.getAuthTag().toString("hex") };
  }

  private decrypt(e: EncEntry): string {
    const decipher = createDecipheriv("aes-256-gcm", this.key!, Buffer.from(e.iv, "hex"));
    decipher.setAuthTag(Buffer.from(e.tag, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(e.ct, "hex")), decipher.final()]).toString("utf8");
  }

  /** True once a vault file has been created on disk. */
  async exists(): Promise<boolean> {
    return (await this.read()) !== null;
  }

  /** Create a brand-new vault protected by this master password. */
  async initialize(masterPassword: string): Promise<void> {
    if (await this.exists()) throw new Error("vault already exists");
    if (masterPassword.length < 8) throw new Error("master password must be at least 8 characters");
    const salt = randomBytes(16);
    this.key = this.deriveKey(masterPassword, salt);
    this.data = { version: 1, salt: salt.toString("hex"), verifier: this.encrypt(VERIFIER_PLAINTEXT), entries: {} };
    await this.persist();
  }

  /** Unlock an existing vault. Throws on the wrong password. */
  async unlock(masterPassword: string): Promise<void> {
    const file = await this.read();
    if (!file) throw new Error("vault does not exist");
    this.key = this.deriveKey(masterPassword, Buffer.from(file.salt, "hex"));
    this.data = file;
    try {
      if (this.decrypt(file.verifier) !== VERIFIER_PLAINTEXT) throw new Error();
    } catch {
      this.key = null;
      this.data = null;
      throw new Error("incorrect master password");
    }
  }

  get unlocked(): boolean {
    return this.key !== null;
  }

  private assertUnlocked(): void {
    if (!this.key || !this.data) throw new Error("vault is locked");
  }

  async set(key: string, value: string): Promise<void> {
    this.assertUnlocked();
    this.data!.entries[key] = this.encrypt(value);
    await this.persist();
  }

  get(key: string): string | undefined {
    this.assertUnlocked();
    const e = this.data!.entries[key];
    return e ? this.decrypt(e) : undefined;
  }

  /** Entry names only — never the values. */
  list(): string[] {
    this.assertUnlocked();
    return Object.keys(this.data!.entries);
  }

  async delete(key: string): Promise<boolean> {
    this.assertUnlocked();
    if (!(key in this.data!.entries)) return false;
    delete this.data!.entries[key];
    await this.persist();
    return true;
  }

  lock(): void {
    this.key = null;
    this.data = null;
  }
}
