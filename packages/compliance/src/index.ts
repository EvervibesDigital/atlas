import type { Plugin } from "@atlas/core";

/**
 * Compliance Watchdog — catches content that could get an account banned or draw
 * legal heat BEFORE it's posted: unsubstantiated income/health claims and
 * missing FTC #ad disclosure on promotional posts. Advisory (severity-scored);
 * the Approval Gateway + Mat make the final call.
 */
export interface Violation {
  rule: string;
  detail: string;
  severity: 1 | 2 | 3;
}

export function checkCompliance(text: string, opts: { captionMax?: number } = {}): Violation[] {
  const v: Violation[] = [];

  if (/\b(guaranteed|guarantee)\b[\s\S]{0,25}\b(income|money|results|profit|returns|rich)\b/i.test(text) || /\bget rich\b/i.test(text)) {
    v.push({ rule: "income-claim", detail: "Unsubstantiated income/earnings guarantee — FTC risk", severity: 3 });
  }
  if (/\b(cure|cures|treat|treats)\b/i.test(text) || /\bguaranteed weight loss\b/i.test(text)) {
    v.push({ rule: "health-claim", detail: "Unsubstantiated health claim", severity: 3 });
  }
  if (/\b(affiliate|sponsored|paid partnership)\b/i.test(text) && !/#ad\b/i.test(text)) {
    v.push({ rule: "disclosure", detail: "Promotional content missing an #ad disclosure", severity: 2 });
  }
  const max = opts.captionMax ?? 2200;
  if (text.length > max) v.push({ rule: "length", detail: `Caption exceeds ${max} characters`, severity: 1 });

  return v.sort((a, b) => b.severity - a.severity);
}

export type ComplianceCommand = { op: "check"; text: string; captionMax?: number };

/** Compliance Watchdog plugin (service "compliance"). */
export function createCompliancePlugin(): Plugin {
  return {
    manifest: { name: "compliance", version: "0.1.0", capabilities: ["compliance"], permissions: [], role: "executor" },
    register(ctx) {
      ctx.provide("compliance", async (payload) => {
        const cmd = payload as ComplianceCommand;
        if (cmd.op !== "check") throw new Error(`compliance: unknown op "${(cmd as { op: string }).op}"`);
        const violations = checkCompliance(cmd.text, { captionMax: cmd.captionMax });
        if (violations.length) await ctx.emit("compliance.flagged", { count: violations.length, worst: violations[0]?.rule });
        return violations;
      });
    },
  };
}
