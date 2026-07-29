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
import { fetchComments, replyToComment, fetchConversationMessages, sendDirectMessage } from "./inbox-graph";
import { scoreConfidence } from "./confidence";
import { newItems, markAutoReplied, markPendingApproval, type InboxItem, type NewInboxItem } from "./inbox-store";

export interface BrainLike {
  (payload: { prompt: string; system?: string }): Promise<{ text: string }>;
}

export type SocialCommand =
  | { op: "getConnectUrl" }
  | { op: "completeConnection"; code: string }
  | { op: "listAccounts" }
  | { op: "queuePosts"; accountId: string; items: Array<Pick<NewSocialPost, "contentItemId" | "caption" | "mediaUrl">> }
  | { op: "publishDuePosts" }
  | { op: "pollInbox" }
  | { op: "listPendingInboxItems" }
  | { op: "respondToInboxItem"; id: string; action: "approve" | "reject" };

export function createSocialPlugin(opts: {
  redirectUri: string;
  accountsFile?: string;
  postsFile?: string;
  inboxFile?: string;
  fetcher?: FetchLike;
  brain?: BrainLike;
}): Plugin {
  const accountsFile = opts.accountsFile ?? "data/social-accounts.json";
  const postsFile = opts.postsFile ?? "data/social-posts.json";
  const inboxFile = opts.inboxFile ?? "data/social-inbox.json";
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

        if (cmd.op === "pollInbox") {
          const tokenKey = await ctx.secret("SOCIAL_TOKEN_KEY");
          if (!tokenKey) throw new Error("social: SOCIAL_TOKEN_KEY not set");
          const brain: BrainLike = opts.brain ?? (async (p) => (await ctx.call("brain", p)) as { text: string });

          const accounts = await loadAccounts(accountsFile);
          const rawPosts = await readFile(postsFile, "utf8").catch(() => "[]");
          const posts = JSON.parse(rawPosts) as SocialPost[];
          const rawInbox = await readFile(inboxFile, "utf8").catch(() => "[]");
          let inbox = JSON.parse(rawInbox) as InboxItem[];

          const candidates: Array<NewInboxItem & { pageAccessToken: string; pageId: string; replyTarget: string; via: "comment" | "dm" }> = [];

          for (const account of accounts) {
            const pageAccessToken = decryptToken(account.accessTokenEnc, tokenKey);

            if (account.platform === "instagram") {
              const publishedOnThisAccount = posts.filter((p) => p.accountId === account.id && p.status === "published" && p.livePostId);
              for (const post of publishedOnThisAccount) {
                const comments = await fetchComments(post.livePostId!, pageAccessToken, fetcher).catch(() => []);
                for (const c of comments) {
                  candidates.push({ accountId: account.id, kind: "comment", externalId: c.id, fromUsername: "", text: c.text, draftReply: "", confidence: 0, pageAccessToken, pageId: account.pageId, replyTarget: c.id, via: "comment" });
                }
              }
            }

            const messages = await fetchConversationMessages(account.pageId, pageAccessToken, fetcher).catch(() => []);
            for (const m of messages) {
              candidates.push({ accountId: account.id, kind: "dm", externalId: m.id, fromUsername: m.fromId, text: m.text, draftReply: "", confidence: 0, pageAccessToken, pageId: account.pageId, replyTarget: m.fromId, via: "dm" });
            }
          }

          const fresh = newItems(candidates, inbox);
          let autoReplied = 0;
          let pendingApproval = 0;

          for (const item of fresh) {
            const { text } = await brain({ prompt: `Someone left this ${item.kind === "comment" ? "comment" : "DM"} on a social post: "${item.text}"\n\nDraft a short, friendly reply in character.`, system: "You reply as a friendly social media persona. Keep it under 2 sentences." });
            const confidence = scoreConfidence(item.text);
            const full: NewInboxItem = { accountId: item.accountId, kind: item.kind, externalId: item.externalId, fromUsername: item.fromUsername, text: item.text, draftReply: text, confidence };

            if (confidence >= 90) {
              if (item.via === "comment") await replyToComment(item.replyTarget, text, item.pageAccessToken, fetcher);
              else await sendDirectMessage(item.pageId, item.replyTarget, text, item.pageAccessToken, fetcher);
              inbox = markAutoReplied(inbox, full);
              autoReplied++;
            } else {
              inbox = markPendingApproval(inbox, full);
              pendingApproval++;
            }
          }

          await writeFile(inboxFile, JSON.stringify(inbox), "utf8");
          return { newItems: fresh.length, autoReplied, pendingApproval };
        }

        if (cmd.op === "listPendingInboxItems") {
          const rawInbox = await readFile(inboxFile, "utf8").catch(() => "[]");
          const inbox = JSON.parse(rawInbox) as InboxItem[];
          return { items: inbox.filter((i) => i.status === "pending_approval") };
        }

        if (cmd.op === "respondToInboxItem") {
          const rawInbox = await readFile(inboxFile, "utf8").catch(() => "[]");
          let inbox = JSON.parse(rawInbox) as InboxItem[];
          const item = inbox.find((i) => i.id === cmd.id);
          if (!item) throw new Error(`social: inbox item "${cmd.id}" not found`);

          if (cmd.action === "approve") {
            const tokenKey = await ctx.secret("SOCIAL_TOKEN_KEY");
            if (!tokenKey) throw new Error("social: SOCIAL_TOKEN_KEY not set");
            const accounts = await loadAccounts(accountsFile);
            const account = accounts.find((a) => a.id === item.accountId);
            if (!account) throw new Error(`social: account for inbox item "${cmd.id}" not found`);
            const pageAccessToken = decryptToken(account.accessTokenEnc, tokenKey);
            if (item.kind === "comment") await replyToComment(item.externalId, item.draftReply, pageAccessToken, fetcher);
            else await sendDirectMessage(account.pageId, item.fromUsername, item.draftReply, pageAccessToken, fetcher);
          }

          inbox = inbox.map((i) => (i.id === cmd.id ? { ...i, status: cmd.action === "approve" ? ("approved" as const) : ("rejected" as const) } : i));
          await writeFile(inboxFile, JSON.stringify(inbox), "utf8");
          return { ok: true };
        }

        throw new Error(`social: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
