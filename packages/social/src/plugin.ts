import type { Plugin } from "@atlas/core";
import { randomUUID } from "node:crypto";
import { buildConnectUrl } from "./oauth";

export type SocialCommand = { op: "getConnectUrl" };

export function createSocialPlugin(opts: { redirectUri: string }): Plugin {
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
        throw new Error(`social: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
