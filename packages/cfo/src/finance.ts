/**
 * CFO core — protects the money. Runway, forecasting, and ROI math so ATLAS
 * (and Mat) never fly blind on cash. Deterministic, offline, testable.
 */
export interface FinancialInputs {
  cashOnHand: number;
  monthlyRevenue: number;
  monthlyExpenses: number;
}

export interface Forecast {
  netMonthly: number;
  /** Months of cash left if burning; null if cash-flow positive. */
  runwayMonths: number | null;
  /** Projected cash at the end of each of the next 6 months. */
  sixMonthProjection: number[];
  verdict: "healthy" | "tight" | "critical";
}

export function forecast(inputs: FinancialInputs): Forecast {
  const netMonthly = inputs.monthlyRevenue - inputs.monthlyExpenses;
  const runwayMonths = netMonthly >= 0 ? null : Number((inputs.cashOnHand / Math.abs(netMonthly)).toFixed(1));

  const sixMonthProjection: number[] = [];
  let cash = inputs.cashOnHand;
  for (let i = 0; i < 6; i++) {
    cash += netMonthly;
    sixMonthProjection.push(Number(cash.toFixed(2)));
  }

  let verdict: Forecast["verdict"] = "healthy";
  if (runwayMonths !== null) verdict = runwayMonths < 3 ? "critical" : runwayMonths < 6 ? "tight" : "healthy";

  return { netMonthly, runwayMonths, sixMonthProjection, verdict };
}

/** Return on investment as a ratio: (return − cost) / cost. */
export function roi(cost: number, expectedReturn: number): number {
  if (cost <= 0) throw new Error("cost must be positive");
  return Number(((expectedReturn - cost) / cost).toFixed(4));
}

export type CfoCommand =
  | { op: "forecast"; inputs: FinancialInputs }
  | { op: "roi"; cost: number; expectedReturn: number };
