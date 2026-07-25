import type { Plugin } from "@atlas/core";
import type { PendingAction, WholesaleCommand } from "./types";

/**
 * Wholesale plugin (service "wholesale") — bridges ATLAS to evervibes' REAL,
 * already-built approval-gate queue for wholesale sends (deal blasts, SMS
 * deal alerts, Bland verification calls, investor outreach emails). That
 * system (lib/wholesale/queue-pending-action.ts) already ranks every
 * candidate action by dollars-at-stake and refuses to fire ANYTHING until
 * approved — this does not reimplement any of that, it calls the existing
 * list/approve/veto endpoints over HTTP, same CRON_SECRET-bearer pattern
 * the kdp bridge already uses.
 *
 * Reuses KDP_CRON_SECRET as the credential on purpose: it's the same
 * evervibes CRON_SECRET value either way, and there's no reason to make Mat
 * paste the identical secret into the vault under a second name.
 */
export function createWholesalePlugin(opts: { fetcher?: typeof fetch } = {}): Plugin {
  const f = opts.fetcher ?? fetch;

  return {
    manifest: {
      name: "wholesale",
      version: "0.1.0",
      capabilities: ["wholesale"],
      permissions: ["secret:*"],
      role: "executor",
    },

    register(ctx) {
      async function base(): Promise<{ url: string; secret: string }> {
        const url = (await ctx.secret("EVERVIBES_APP_URL")) || "https://evervibesdigital.com";
        const secret = await ctx.secret("KDP_CRON_SECRET");
        if (!secret) throw new Error("wholesale: no KDP_CRON_SECRET set — add it in API Keys (same value as evervibes' CRON_SECRET env var)");
        return { url, secret };
      }

      ctx.provide("wholesale", async (payload) => {
        const cmd = payload as WholesaleCommand;

        if (cmd.op === "list") {
          const { url, secret } = await base();
          const r = await f(`${url}/api/wholesale/pending-actions/list`, { headers: { Authorization: `Bearer ${secret}` } });
          const data = (await r.json().catch(() => ({}))) as { actions?: PendingAction[] };
          if (!r.ok) throw new Error(`wholesale list HTTP ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
          return { actions: data.actions ?? [] };
        }

        if (cmd.op === "approve") {
          const { url, secret } = await base();
          const r = await f(`${url}/api/wholesale/pending-actions/${cmd.id}/approve`, {
            method: "POST",
            headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
          });
          const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
          if (!r.ok) throw new Error(`wholesale approve HTTP ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
          await ctx.emit("wholesale.approved", { id: cmd.id });
          return data;
        }

        if (cmd.op === "veto") {
          const { url, secret } = await base();
          const r = await f(`${url}/api/wholesale/pending-actions/${cmd.id}/veto`, {
            method: "POST",
            headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
            body: JSON.stringify({ reason: cmd.reason ?? "atlas_brief_reject" }),
          });
          const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
          if (!r.ok) throw new Error(`wholesale veto HTTP ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
          return data;
        }

        throw new Error(`wholesale: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
