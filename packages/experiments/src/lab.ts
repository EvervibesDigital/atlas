import { randomUUID } from "node:crypto";

/**
 * Experiment Lab — safe A/B testing. Register an experiment with variants,
 * record wins/losses, and evaluate the winner once there's enough evidence.
 * Nothing is deployed automatically; the winner is a recommendation.
 */
export interface Variant {
  name: string;
  trials: number;
  wins: number;
}

export interface Experiment {
  id: string;
  name: string;
  variants: Variant[];
  status: "running" | "decided";
  winner?: string;
}

export class ExperimentLab {
  private experiments = new Map<string, Experiment>();

  start(name: string, variantNames: string[]): Experiment {
    if (variantNames.length < 2) throw new Error("an experiment needs at least 2 variants");
    const exp: Experiment = {
      id: randomUUID(),
      name,
      variants: variantNames.map((n) => ({ name: n, trials: 0, wins: 0 })),
      status: "running",
    };
    this.experiments.set(exp.id, exp);
    return exp;
  }

  record(id: string, variantName: string, won: boolean): void {
    const exp = this.get(id);
    if (!exp) throw new Error(`no experiment "${id}"`);
    const v = exp.variants.find((x) => x.name === variantName);
    if (!v) throw new Error(`no variant "${variantName}"`);
    v.trials++;
    if (won) v.wins++;
  }

  /** Pick the best variant once at least one has `minTrials`. Returns null otherwise. */
  evaluate(id: string, minTrials = 10): string | null {
    const exp = this.get(id);
    if (!exp) throw new Error(`no experiment "${id}"`);
    const eligible = exp.variants.filter((v) => v.trials >= minTrials);
    if (eligible.length === 0) return null;
    const best = eligible.reduce((a, b) => (b.wins / b.trials > a.wins / a.trials ? b : a));
    exp.status = "decided";
    exp.winner = best.name;
    return best.name;
  }

  get(id: string): Experiment | undefined {
    return this.experiments.get(id);
  }
  list(): Experiment[] {
    return [...this.experiments.values()];
  }
}

export type ExperimentCommand =
  | { op: "start"; name: string; variants: string[] }
  | { op: "record"; id: string; variant: string; won: boolean }
  | { op: "evaluate"; id: string; minTrials?: number }
  | { op: "list" };
