import type { DailyReport } from "@atlas/orchestrator";
import { buildAtlas, type AtlasOptions } from "./build";

/**
 * Run one autonomous daily cycle and return the report. Builds ATLAS, then adds
 * a minimal "cron" trigger plugin (the only thing allowed to call the
 * orchestrator) and fires one cycle.
 */
export async function runDailyCycle(
  opts: AtlasOptions & { personaHandle?: string; topic?: string; videoRef?: string | null } = {},
): Promise<DailyReport> {
  const atlas = await buildAtlas(opts);

  let report: DailyReport | undefined;
  await atlas.use({
    manifest: { name: "cron", version: "1", capabilities: [], permissions: ["call:orchestrator"], role: "executor" },
    async register(ctx) {
      report = (await ctx.call("orchestrator", {
        op: "runDailyCycle",
        personaHandle: opts.personaHandle,
        topic: opts.topic,
        videoRef: opts.videoRef ?? null,
      })) as DailyReport;
    },
  });

  if (!report) throw new Error("daily cycle produced no report");
  return report;
}
