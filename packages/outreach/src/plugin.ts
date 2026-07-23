import type { Plugin } from "@atlas/core";
import { N8nClient, type FetchLike } from "./n8n-client";
import type { OutreachCommand, OutreachTarget } from "./types";

/**
 * Outreach plugin (service "outreach") — bridges ATLAS to the real
 * send-side plumbing that already runs in n8n.evervibes.org for two
 * businesses: the compliance bot's lead intake/onboarding, and wholesale's
 * buyer/seller alerts. Both were built once by Mat and are archived/idle,
 * not missing — this lets ATLAS see them and fire one, per approved item,
 * instead of rebuilding an email/SMS sender from scratch.
 *
 * Every op here that actually sends something (a "notify") is a real,
 * user-visible action — an email to a lead, an SMS to a buyer, a phone
 * verification call. This plugin never calls itself on a schedule; it is
 * only ever invoked in response to Mat approving ONE specific item (via the
 * Morning Brief or a direct chat command). `setActive` similarly only flips
 * one workflow on/off when Mat asks — it is not a bulk "turn everything on".
 *
 * Requires N8N_API_KEY in the vault (Keys tab).
 */

/** The webhook path for each known, invokable target (confirmed live 2026-07-2x). */
const WEBHOOK_PATHS: Record<OutreachTarget, string> = {
  "new-lead": "new-lead",
  "deal-alert-sms": "deal-alert-sms",
  "bird-dog-verify": "bird-dog-verify",
};

export function createOutreachPlugin(opts: { fetcher?: FetchLike; n8nBase?: string } = {}): Plugin {
  return {
    manifest: {
      name: "outreach",
      version: "0.1.0",
      capabilities: ["outreach"],
      permissions: ["secret:*", "call:memory"],
      role: "executor",
    },

    register(ctx) {
      async function client(): Promise<N8nClient> {
        const key = await ctx.secret("N8N_API_KEY");
        if (!key) throw new Error("outreach: no N8N_API_KEY set — add it in the Keys tab to let ATLAS see and trigger your n8n workflows");
        return new N8nClient(key, opts.fetcher ?? fetch, opts.n8nBase);
      }

      ctx.provide("outreach", async (payload) => {
        const cmd = payload as OutreachCommand;
        const c = await client();

        if (cmd.op === "listWorkflows") {
          return { workflows: await c.listWorkflows() };
        }

        if (cmd.op === "setActive") {
          await c.setActive(cmd.id, cmd.active);
          return { id: cmd.id, active: cmd.active };
        }

        if (cmd.op === "notify") {
          const path = WEBHOOK_PATHS[cmd.target];
          if (!path) throw new Error(`outreach: unknown target "${cmd.target}"`);
          const result = await c.triggerWebhook(path, cmd.payload);
          try {
            await ctx.call("memory", { op: "remember", input: { kind: "task", content: `Outreach: sent "${cmd.target}" via n8n for ${JSON.stringify(cmd.payload).slice(0, 200)}` } });
          } catch {
            /* memory optional */
          }
          await ctx.emit("outreach.sent", { target: cmd.target, payload: cmd.payload });
          return result;
        }

        throw new Error(`outreach: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
