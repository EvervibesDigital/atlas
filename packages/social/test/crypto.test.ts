import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { encryptToken, decryptToken } from "../src/crypto";

describe("encryptToken / decryptToken", () => {
  const key = randomBytes(32).toString("hex");

  it("round-trips a plaintext token", () => {
    const entry = encryptToken("EAABsbCS...fake-token", key);
    expect(decryptToken(entry, key)).toBe("EAABsbCS...fake-token");
  });

  it("never stores the plaintext anywhere in the encrypted entry", () => {
    const entry = encryptToken("super-secret-value", key);
    expect(JSON.stringify(entry)).not.toContain("super-secret-value");
  });

  it("fails to decrypt with the wrong key", () => {
    const entry = encryptToken("a-token", key);
    const wrongKey = randomBytes(32).toString("hex");
    expect(() => decryptToken(entry, wrongKey)).toThrow();
  });
});
