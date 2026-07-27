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
      permissions: ["secret:META_APP_ID", "secret:META_APP_SECRET", "secret:SOCIAL_TOKEN_KEY"],
      role: "executor",
    },
    register(ctx) {
      ctx.provide("social", async (payload) => {
        const cmd = payload as SocialCommand;
        if (cmd.op === "getConnectUrl") {
          const appId = await ctx.secret("META_APP_ID");
          if (!appId) throw new Error("social: META_APP_ID not set — add it in API Keys first");
          const state = randomUUID();
          return { url: buildConnectUrl(appId, opts.redirectUri, state), state };
        }
        throw new Error(`social: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
