import type { Plugin } from "@atlas/core";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { buildConnectUrl } from "./oauth";
import { exchangeCodeForToken, type FetchLike } from "./token-exchange";
import { exchangeForLongLivedToken, fetchPagesWithInstagram } from "./graph";
import { encryptToken, decryptToken } from "./crypto";
import { addAccount, loadAccounts, type SocialAccount } from "./store";
import { enqueueStaggeredPosts, duePosts, markPublished, markFailed, type SocialPost, type NewSocialPost } from "./post-queue";
import { postToInstagram, postToFacebookPage } from "./posting";

export type SocialCommand =
  | { op: "getConnectUrl" }
  | { op: "completeConnection"; code: string }
  | { op: "listAccounts" }
  | { op: "queuePosts"; accountId: string; items: Array<Pick<NewSocialPost, "contentItemId" | "caption" | "mediaUrl">> }
  | { op: "publishDuePosts" };

export function createSocialPlugin(opts: { redirectUri: string; accountsFile?: string; postsFile?: string; fetcher?: FetchLike }): Plugin {
  const accountsFile = opts.accountsFile ?? "data/social-accounts.json";
  const postsFile = opts.postsFile ?? "data/social-posts.json";
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

        if (cmd.op === "listAccounts") {
          const accounts = await loadAccounts(accountsFile);
          return { accounts: accounts.map((a) => ({ id: a.id, personaLabel: a.personaLabel, platform: a.platform })) };
        }

        if (cmd.op === "queuePosts") {
          const accounts = await loadAccounts(accountsFile);
          const account = accounts.find((a) => a.id === cmd.accountId);
          if (!account) throw new Error(`social: account "${cmd.accountId}" not found — it may have been disconnected`);

          const mediaType = "image" as const; // video support waits on Media Factory's multi-scene gap, see Plan 1's "Next"
          const newPosts: NewSocialPost[] = cmd.items.map((i) => ({ contentItemId: i.contentItemId, accountId: cmd.accountId, mediaType, caption: i.caption, mediaUrl: i.mediaUrl }));
          const staggered = enqueueStaggeredPosts(newPosts, new Date(), 6);

          const existingRaw = await readFile(postsFile, "utf8").catch(() => "[]");
          const existing = JSON.parse(existingRaw) as SocialPost[];
          await writeFile(postsFile, JSON.stringify([...existing, ...staggered]), "utf8");
          return { queued: staggered.length };
        }

        if (cmd.op === "publishDuePosts") {
          const tokenKey = await ctx.secret("SOCIAL_TOKEN_KEY");
          if (!tokenKey) throw new Error("social: SOCIAL_TOKEN_KEY not set");

          const accounts = await loadAccounts(accountsFile);
          const rawPosts = await readFile(postsFile, "utf8").catch(() => "[]");
          let posts = JSON.parse(rawPosts) as SocialPost[];
          const due = duePosts(posts, new Date());

          let published = 0;
          let failed = 0;
          for (const post of due) {
            const account = accounts.find((a) => a.id === post.accountId);
            if (!account) {
              posts = markFailed(posts, post.id, `account "${post.accountId}" no longer connected`);
              failed++;
              continue;
            }
            try {
              const pageAccessToken = decryptToken(account.accessTokenEnc, tokenKey);
              const result = account.platform === "instagram" && account.igBusinessAccountId
                ? await postToInstagram({ igBusinessAccountId: account.igBusinessAccountId, imageUrl: post.mediaUrl, caption: post.caption, pageAccessToken, fetcher })
                : await postToFacebookPage({ pageId: account.pageId, imageUrl: post.mediaUrl, caption: post.caption, pageAccessToken, fetcher });
              posts = markPublished(posts, post.id, result.livePostId);
              published++;
            } catch (err) {
              posts = markFailed(posts, post.id, (err as Error).message);
              failed++;
            }
          }
          await writeFile(postsFile, JSON.stringify(posts), "utf8");
          return { published, failed };
        }

        throw new Error(`social: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
