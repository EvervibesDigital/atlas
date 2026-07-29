import type { Plugin } from "@atlas/core";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { buildConnectUrl } from "./oauth";
import { exchangeCodeForToken, type FetchLike } from "./token-exchange";
import { exchangeForLongLivedToken, fetchPagesWithInstagram } from "./graph";
import { encryptToken } from "./crypto";
import { addAccount, type SocialAccount } from "./store";

export type SocialCommand = { op: "getConnectUrl" } | { op: "completeConnection"; code: string };

export function createSocialPlugin(opts: { redirectUri: string; accountsFile?: string; fetcher?: FetchLike }): Plugin {
  const accountsFile = opts.accountsFile ?? "data/social-accounts.json";
  const fetcher: FetchLike = opts.fetcher ?? (fetch as unknown as FetchLike);

  return {
    manifest: {
      name: "social",
      version: "0.1.0",
      capabilities: ["social"],
      permissions: ["secret:META_APP_ID", "secret:META_APP_SECRET", "secret:SOCIAL_LOGIN_CONFIG_ID", "secret:SOCIAL_TOKEN_KEY"],
      role: "executor",
    },
    register(ctx) {
      ctx.provide("social", async (payload) => {
        const cmd = payload as SocialCommand;

        if (cmd.op === "getConnectUrl") {
          const appId = await ctx.secret("META_APP_ID");
          if (!appId) throw new Error("social: META_APP_ID not set — add it in API Keys first");
          const configId = await ctx.secret("SOCIAL_LOGIN_CONFIG_ID");
          if (!configId) throw new Error("social: SOCIAL_LOGIN_CONFIG_ID not set — create a Login Configuration in the Meta App Dashboard first, then add its ID in API Keys");
          const state = randomUUID();
          return { url: buildConnectUrl(appId, configId, opts.redirectUri, state), state };
        }

        if (cmd.op === "completeConnection") {
          const appId = await ctx.secret("META_APP_ID");
          if (!appId) throw new Error("social: META_APP_ID not set — add it in API Keys first");
          const appSecret = await ctx.secret("META_APP_SECRET");
          if (!appSecret) throw new Error("social: META_APP_SECRET not set — add it in API Keys first");
          const tokenKey = await ctx.secret("SOCIAL_TOKEN_KEY");
          if (!tokenKey) throw new Error("social: SOCIAL_TOKEN_KEY not set — generate one and add it in API Keys first");

          // 1. Short-lived token from the OAuth code.
          const shortLived = await exchangeCodeForToken(cmd.code, appId, appSecret, opts.redirectUri, fetcher);
          // 2. Exchange for a long-lived (~60 day) user token.
          const longLived = await exchangeForLongLivedToken(shortLived.accessToken, appId, appSecret, fetcher);
          // 3. The Pages this user manages, each with its own Page token
          //    (needed for posting) and linked Instagram Business Account.
          const pages = await fetchPagesWithInstagram(longLived.accessToken, fetcher);

          const existingRaw = await readFile(accountsFile, "utf8").catch(() => "[]");
          let accounts = JSON.parse(existingRaw) as SocialAccount[];
          const now = new Date().toISOString();
          const connected: Array<{ platform: string; personaLabel: string }> = [];

          for (const page of pages) {
            const facebookAccount: SocialAccount = {
              id: randomUUID(),
              platform: "facebook",
              personaLabel: page.pageName,
              pageId: page.pageId,
              accessTokenEnc: encryptToken(page.pageAccessToken, tokenKey),
              tokenObtainedAt: now,
              connectedAt: now,
              status: "connected",
            };
            accounts = addAccount(accounts, facebookAccount);
            connected.push({ platform: "facebook", personaLabel: page.pageName });

            if (page.igBusinessAccountId) {
              const igAccount: SocialAccount = {
                id: randomUUID(),
                platform: "instagram",
                personaLabel: page.pageName,
                pageId: page.pageId,
                igBusinessAccountId: page.igBusinessAccountId,
                accessTokenEnc: encryptToken(page.pageAccessToken, tokenKey),
                tokenObtainedAt: now,
                connectedAt: now,
                status: "connected",
              };
              accounts = addAccount(accounts, igAccount);
              connected.push({ platform: "instagram", personaLabel: page.pageName });
            }
          }

          await writeFile(accountsFile, JSON.stringify(accounts), "utf8");
          return { connected };
        }

        throw new Error(`social: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
