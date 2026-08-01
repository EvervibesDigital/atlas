import type { Plugin } from "@atlas/core";
import { parseUsAddress } from "./address";
import { TwinEnrichmentClient, type FetchLike } from "./twin-client";
import { parseEnrichmentResults, type EnrichmentResult } from "./results";

/** Twin's Batch Skip Tracer (workspace 019f82ad-…). Verified live 2026-08-01. */
export const BATCH_SKIP_TRACER_AGENT_ID = "019f82af-8407-7bcb-aebd-f7d42cc92834";

/** Twin bills $0.070 per MATCHED property (not per attempt). */
export const COST_PER_MATCH_USD = 0.07;

export interface EnrichmentTarget {
  /** Caller's own row id — echoed back so results can be matched to rows. */
  id: string;
  /** Raw one-line mailing address, exactly as stored. Parsed here. */
  address: string;
  firstName?: string;
  lastName?: string;
}

export interface EnrichmentPreview {
  total: number;
  highConfidence: number;
  lowConfidence: number;
  /** No trailing STATE ZIP to anchor on — cannot be traced as-is. */
  unusable: number;
  /** high + low: what would actually be sent. */
  traceable: number;
  estimatedCostUsd: number;
}

export type EnrichmentCommand =
  | { op: "preview"; targets: EnrichmentTarget[] }
  | { op: "enrich"; targets: EnrichmentTarget[]; confirmCost?: boolean };

export function buildPreview(targets: EnrichmentTarget[]): EnrichmentPreview {
  let high = 0;
  let low = 0;
  let unusable = 0;
  for (const t of targets) {
    const p = parseUsAddress(t.address ?? "");
    if (!p) unusable++;
    else if (p.confidence === "high") high++;
    else low++;
  }
  const traceable = high + low;
  return {
    total: targets.length,
    highConfidence: high,
    lowConfidence: low,
    unusable,
    traceable,
    estimatedCostUsd: Number((traceable * COST_PER_MATCH_USD).toFixed(2)),
  };
}

/** The message handed to the Twin agent. Its own instructions say it parses
 * unstructured text itself, so low-confidence splits are still worth sending —
 * but we send the parsed fields when we have them, since the agent's spec
 * states name/structured fields measurably improve match rates. */
export function buildRunMessage(targets: EnrichmentTarget[]): string {
  const lines = targets.map((t) => {
    const p = parseUsAddress(t.address ?? "");
    const name = [t.firstName, t.lastName].filter(Boolean).join(" ");
    if (!p) return `id=${t.id} | ${t.address}${name ? ` | ${name}` : ""}`;
    return `id=${t.id} | street=${p.street} | city=${p.city} | state=${p.state} | zip=${p.zip}${name ? ` | name=${name}` : ""}`;
  });
  return [
    "Skip trace the following properties and return, for each, the id together with any phone numbers and email addresses found.",
    "Return the results as structured data keyed by the id given on each line. Do not omit the id.",
    "",
    ...lines,
  ].join("\n");
}

/**
 * Shared enrichment capability (service "enrichment").
 *
 * Missing contact data is the same bottleneck in two of Mat's businesses:
 * surplus funds has 68 leads with 0 emails, wholesale had 826 buyers with 13.
 * This orchestrates Twin's existing Batch Skip Tracer rather than rebuilding
 * skip tracing, which runs off a Twin platform tool that can't be replicated
 * here anyway.
 *
 * SAFETY: `enrich` costs real money and REFUSES to run without an explicit
 * `confirmCost: true`. That is structural, not ceremony — a lot of things get
 * wired into the hourly cycle, and a capability that spends money must be
 * impossible to add to an automated loop by accident. `preview` is free and
 * carries the cost estimate, so there is always a no-cost way to look first.
 * This plugin is deliberately NOT in the orchestrator's cycle and the
 * orchestrator is deliberately NOT granted `call:enrichment`.
 */
export function createEnrichmentPlugin(opts: { fetcher?: FetchLike; agentId?: string } = {}): Plugin {
  const agentId = opts.agentId ?? BATCH_SKIP_TRACER_AGENT_ID;

  return {
    manifest: {
      name: "enrichment",
      version: "0.1.0",
      capabilities: ["enrichment"],
      permissions: ["secret:*", "call:memory"],
      role: "executor",
    },

    register(ctx) {
      ctx.provide("enrichment", async (payload) => {
        const cmd = payload as EnrichmentCommand;

        if (cmd.op === "preview") {
          return buildPreview(cmd.targets ?? []);
        }

        if (cmd.op === "enrich") {
          const targets = cmd.targets ?? [];
          const preview = buildPreview(targets);

          if (cmd.confirmCost !== true) {
            throw new Error(
              `enrichment: refusing to spend money without confirmCost:true — this would trace ${preview.traceable} propert${preview.traceable === 1 ? "y" : "ies"} at about $${preview.estimatedCostUsd}. Run {op:"preview"} first (free), then pass confirmCost:true deliberately.`,
            );
          }
          if (preview.traceable === 0) {
            return { results: [] as EnrichmentResult[], preview, note: "nothing traceable — no address had a usable state+zip" };
          }

          const apiKey = await ctx.secret("TWIN_API_KEY");
          if (!apiKey) throw new Error("enrichment: no TWIN_API_KEY set — add it in API Keys");

          const client = new TwinEnrichmentClient(apiKey, opts.fetcher);
          const traceable = targets.filter((t) => parseUsAddress(t.address ?? "") !== null);
          const runId = await client.startRun(agentId, buildRunMessage(traceable));
          const events = await client.waitForRun(agentId, runId);
          const results = parseEnrichmentResults(events);

          try {
            await ctx.call("memory", {
              op: "remember",
              input: { kind: "task", content: `Enrichment run ${runId}: traced ${traceable.length}, matched ${results.filter((r) => r.matched).length}` },
            });
          } catch {
            /* memory optional */
          }

          return { runId, results, preview };
        }

        throw new Error(`enrichment: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
