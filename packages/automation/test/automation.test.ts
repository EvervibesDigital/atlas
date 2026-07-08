import { describe, it, expect } from "vitest";
import { scoreProcess, rankProcesses } from "../src/index";

describe("automation hunter", () => {
  it("prioritizes frequent, long, multi-step manual work", () => {
    const daily = { name: "manual posting", frequencyPerWeek: 7, minutesEach: 15, manualSteps: 5 };
    const rare = { name: "monthly report", frequencyPerWeek: 0.25, minutesEach: 30, manualSteps: 2 };
    expect(scoreProcess(daily).score).toBeGreaterThan(scoreProcess(rare).score);
  });

  it("labels a high time-drain process 'Automate now'", () => {
    const ranked = rankProcesses([{ name: "x", frequencyPerWeek: 10, minutesEach: 10, manualSteps: 3 }]);
    expect(ranked[0]!.recommendation).toMatch(/Automate now/);
    expect(ranked[0]!.weeklyMinutes).toBe(100);
  });
});
