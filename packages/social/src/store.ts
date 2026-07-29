import type { EncryptedValue } from "./crypto";

export interface SocialAccount {
  id: string;
  platform: "instagram" | "facebook";
  personaLabel: string;
  pageId: string;
  igBusinessAccountId?: string;
  accessTokenEnc: EncryptedValue;
  tokenObtainedAt: string;
  connectedAt: string;
  status: "connected" | "token_expired" | "error";
}

export function addAccount(accounts: SocialAccount[], account: SocialAccount): SocialAccount[] {
  return [...accounts, account];
}

export function findAccount(accounts: SocialAccount[], id: string): SocialAccount | undefined {
  return accounts.find((a) => a.id === id);
}

export async function loadAccounts(accountsFile: string): Promise<SocialAccount[]> {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(accountsFile, "utf8").catch(() => "[]");
  return JSON.parse(raw) as SocialAccount[];
}

/** Meta long-lived Page tokens are valid ~60 days. Used to warn before one
 * silently expires (feeds the urgent-alert email already shipped). */
export function daysUntilExpiry(tokenObtainedAt: string, validityDays = 60): number {
  const obtained = new Date(tokenObtainedAt).getTime();
  const expiresAt = obtained + validityDays * 24 * 3600_000;
  return Math.floor((expiresAt - Date.now()) / (24 * 3600_000));
}
