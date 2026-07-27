import { describe, it, expect } from "vitest";
import { addAccount, findAccount, daysUntilExpiry, type SocialAccount } from "../src/store";

function account(id: string, obtainedAt: string): SocialAccount {
  return {
    id,
    platform: "instagram",
    personaLabel: "Aria Vance",
    pageId: "page123",
    igBusinessAccountId: "ig456",
    accessTokenEnc: { iv: "i", ct: "c", tag: "t" },
    tokenObtainedAt: obtainedAt,
    connectedAt: obtainedAt,
    status: "connected",
  };
}

describe("addAccount / findAccount", () => {
  it("adds a new account to the list", () => {
    const accounts = addAccount([], account("a1", new Date().toISOString()));
    expect(accounts).toHaveLength(1);
    expect(findAccount(accounts, "a1")?.personaLabel).toBe("Aria Vance");
  });

  it("findAccount returns undefined for an unknown id", () => {
    expect(findAccount([], "missing")).toBeUndefined();
  });
});

describe("daysUntilExpiry", () => {
  it("returns close to 60 for a token obtained just now (60-day validity)", () => {
    const days = daysUntilExpiry(new Date().toISOString());
    expect(days).toBeGreaterThanOrEqual(59);
    expect(days).toBeLessThanOrEqual(60);
  });

  it("returns a negative number for an already-expired token", () => {
    const obtained = new Date(Date.now() - 70 * 24 * 3600_000).toISOString();
    expect(daysUntilExpiry(obtained)).toBeLessThan(0);
  });
});
