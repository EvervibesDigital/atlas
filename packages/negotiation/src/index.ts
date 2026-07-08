import type { Plugin } from "@atlas/core";

/**
 * Negotiation Agent — plans vendor/contract/pricing negotiations. Computes an
 * anchor (opening), the target, the walk-away, and whether a deal is even
 * possible (the ZOPA — zone of possible agreement), plus battle-tested tactics.
 */
export interface NegotiationInputs {
  role: "buyer" | "seller";
  /** Price we'd be happy with. */
  target: number;
  /** The number we walk away past (buyer: max we'll pay; seller: min we'll accept). */
  walkaway: number;
  /** Our estimate of the other side's likely number. */
  theirLikely: number;
}

export interface NegotiationPlan {
  role: "buyer" | "seller";
  opening: number;
  target: number;
  walkaway: number;
  /** Overlap where a deal can happen, or null if there's no room. */
  zopa: [number, number] | null;
  tactics: string[];
}

export function planNegotiation(i: NegotiationInputs): NegotiationPlan {
  const opening = i.role === "buyer" ? Math.round(i.target * 0.85) : Math.round(i.target * 1.15);

  let zopa: [number, number] | null = null;
  if (i.role === "buyer") {
    if (i.theirLikely <= i.walkaway) zopa = [i.theirLikely, i.walkaway];
  } else if (i.theirLikely >= i.walkaway) {
    zopa = [i.walkaway, i.theirLikely];
  }

  const tactics = [
    "Anchor first — open with your opening number, not your target",
    "Justify every number with data, not emotion",
    "Stay silent after making an offer; let them respond",
    "Trade concessions, never give them away for free",
    "Be genuinely ready to walk at your walk-away",
  ];

  return { role: i.role, opening, target: i.target, walkaway: i.walkaway, zopa, tactics };
}

export type NegotiationCommand = { op: "plan"; inputs: NegotiationInputs };

/** Negotiation plugin (service "negotiation"). */
export function createNegotiationPlugin(): Plugin {
  return {
    manifest: { name: "negotiation", version: "0.1.0", capabilities: ["negotiation"], permissions: [], role: "executor" },
    register(ctx) {
      ctx.provide("negotiation", (payload) => {
        const cmd = payload as NegotiationCommand;
        if (cmd.op !== "plan") throw new Error(`negotiation: unknown op "${(cmd as { op: string }).op}"`);
        return planNegotiation(cmd.inputs);
      });
    },
  };
}
