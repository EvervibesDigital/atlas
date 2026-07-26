import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Plugin } from "@atlas/core";
import { computeVitals } from "./vitals";
import type { LearningMetricLike, PendingLike, VitalsCommand, VitalsSnapshot } from "./types";

/**
 * Vitals plugin (service "vitals") — ATLAS's self-awareness. Once per cycle it
 * asks itself three questions Mat actually cares about:
 *
 *   • OUTPUT   — is work FLOWING, or backing up? (pipeline depth + stall age)
 *   • GROWTH   — is ATLAS EXPANDING? (knowledge accumulating, pipeline growing)
 *   • LEARNING — is it recording outcomes and improving from them?
 *
 * It reads the same live sources everything else uses (brief, memory, learning)
 * — no new bookkeeping — compares against the last snapshot to spot stalls, and
 * raises human-readable flags. This is how ATLAS notices its OWN idleness: an
 * 18-deep gig queue that hasn't moved in a week, or a learning loop that's
 * never recorded a single result, becomes a line in the morning report instead
 * of an invisible dead end.
 *
 * Read-only and side-effect-free except for persisting its own snapshot —
 * safe to run every cycle, unattended.
 */
export function createVitalsPlugin(opts: { snapshotFile?: string } = {}): Plugin {
  let cached: VitalsSnapshot | undefined;
  let loaded = false;

  async function loadPrev(): Promise<VitalsSnapshot | undefined> {
    if (loaded) return cached;
    loaded = true;
    if (!opts.snapshotFile) return undefined;
    try {
      cached = JSON.parse(await readFile(opts.snapshotFile, "utf8")) as VitalsSnapshot;
    } catch {
      cached = undefined;
    }
    return cached;
  }

  async function savePrev(snapshot: VitalsSnapshot): Promise<void> {
    cached = snapshot;
    if (!opts.snapshotFile) return;
    await mkdir(dirname(opts.snapshotFile), { recursive: true });
    await writeFile(opts.snapshotFile, JSON.stringify(snapshot, null, 2), "utf8");
  }

  return {
    manifest: {
      name: "vitals",
      version: "0.1.0",
      capabilities: ["vitals"],
      permissions: ["call:brief", "call:memory", "call:learning", "call:cfo"],
      role: "executor",
    },

    register(ctx) {
      ctx.provide("vitals", async (payload) => {
        const cmd = payload as VitalsCommand;
        if (cmd.op !== "check") throw new Error(`vitals: unknown op "${(cmd as { op: string }).op}"`);

        // Gather from live sources — each isolated so one missing service
        // (e.g. brief not loaded in a slim test) doesn't blank the whole check.
        let pending: PendingLike[] = [];
        try {
          const brief = (await ctx.call("brief", { op: "today" })) as { items?: PendingLike[] };
          pending = brief.items ?? [];
        } catch {
          /* brief unavailable — treat as empty pipeline */
        }

        // Knowledge = learned records, EXCLUDING operational noise ("timeline"
        // activity logs — which include vitals' OWN flag notes and autopilot
        // notes — and "conversation" chat turns). Counting those would let
        // ATLAS's own logging inflate "knowledge grew" and mask a real stall.
        let knowledge = 0;
        try {
          const [total, timeline, conversation] = (await Promise.all([
            ctx.call("memory", { op: "count" }),
            ctx.call("memory", { op: "count", kind: "timeline" }),
            ctx.call("memory", { op: "count", kind: "conversation" }),
          ])) as [number, number, number];
          knowledge = total - timeline - conversation;
        } catch {
          /* memory unavailable */
        }

        let metrics: LearningMetricLike[] = [];
        try {
          const all = (await ctx.call("learning", { op: "metrics" })) as LearningMetricLike[] | LearningMetricLike;
          metrics = Array.isArray(all) ? all : all ? [all] : [];
        } catch {
          /* learning unavailable */
        }

        // Real MRR, undefined (not 0) when the bridge isn't configured/reachable.
        let mrr: number | undefined;
        try {
          const real = (await ctx.call("cfo", { op: "pullReal" })) as { mrr?: number };
          if (typeof real.mrr === "number") mrr = real.mrr;
        } catch {
          /* cfo unavailable or bridge not configured — mrr stays undefined */
        }

        const prev = await loadPrev();
        const { report, snapshot } = computeVitals({ pending, knowledge, metrics, prev, mrr });
        await savePrev(snapshot);

        // Persist a timeline note ONLY when something's flagged — a healthy
        // check is silent, a stall is a memory Mat (and the next cycle) can see.
        if (report.flags.length > 0) {
          try {
            await ctx.call("memory", { op: "remember", input: { kind: "timeline", content: `Vitals flags: ${report.flags.join(" | ")}`.slice(0, 1500) } });
          } catch {
            /* memory optional */
          }
          await ctx.emit("vitals.flagged", { flags: report.flags });
        }

        return report;
      });
    },
  };
}
