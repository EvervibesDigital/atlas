import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

export interface EncryptedValue {
  iv: string;
  ct: string;
  tag: string;
}

/** AES-256-GCM, same primitives as @atlas/vault — but keyed by a value the
 * caller supplies (SOCIAL_TOKEN_KEY from the vault), not a master password.
 * Plugins can't write new vault entries themselves (a deliberate boundary —
 * see @atlas/vault), so social tokens get their own encrypted-at-rest file
 * instead, gated by a key Mat sets once the same way every other credential
 * in ATLAS is set. */
export function encryptToken(plaintext: string, keyHex: string): EncryptedValue {
  const key = Buffer.from(keyHex, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { iv: iv.toString("hex"), ct: ct.toString("hex"), tag: cipher.getAuthTag().toString("hex") };
}

export function decryptToken(entry: EncryptedValue, keyHex: string): string {
  const key = Buffer.from(keyHex, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(entry.iv, "hex"));
  decipher.setAuthTag(Buffer.from(entry.tag, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(entry.ct, "hex")), decipher.final()]).toString("utf8");
}
