import type { Plugin } from "@atlas/core";

/**
 * Simulation Agent — "what happens if…". Projects a starting value forward under
 * a weekly growth rate so ATLAS can compare choices BEFORE committing (e.g.
 * "what if we post daily vs 3×/week?").
 */
export interface Scenario {
  label?: string;
  startValue: number;
  weeklyGrowthPct: number;
  weeks: number;
}

export interface SimResult {
  label?: string;
  finalValue: number;
  series: number[];
}

export function simulate(s: Scenario): SimResult {
  const series: number[] = [];
  let value = s.startValue;
  for (let i = 0; i < s.weeks; i++) {
    value *= 1 + s.weeklyGrowthPct / 100;
    series.push(Number(value.toFixed(2)));
  }
  return { label: s.label, finalValue: series.at(-1) ?? s.startValue, series };
}

export interface Comparison {
  base: SimResult;
  variant: SimResult;
  deltaPct: number;
  recommend: "base" | "variant";
}

export function compareScenarios(base: Scenario, variant: Scenario): Comparison {
  const b = simulate(base);
  const v = simulate(variant);
  const deltaPct = b.finalValue === 0 ? 0 : Number((((v.finalValue - b.finalValue) / b.finalValue) * 100).toFixed(2));
  return { base: b, variant: v, deltaPct, recommend: v.finalValue >= b.finalValue ? "variant" : "base" };
}

export type SimulationCommand = { op: "run"; scenario: Scenario } | { op: "compare"; base: Scenario; variant: Scenario };

/** Simulation Agent plugin (service "simulation"). */
export function createSimulationPlugin(): Plugin {
  return {
    manifest: { name: "simulation", version: "0.1.0", capabilities: ["simulation"], permissions: [], role: "executor" },
    register(ctx) {
      ctx.provide("simulation", async (payload) => {
        const cmd = payload as SimulationCommand;
        if (cmd.op === "run") return simulate(cmd.scenario);
        if (cmd.op === "compare") {
          const result = compareScenarios(cmd.base, cmd.variant);
          await ctx.emit("simulation.compared", { recommend: result.recommend, deltaPct: result.deltaPct });
          return result;
        }
        throw new Error(`simulation: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
