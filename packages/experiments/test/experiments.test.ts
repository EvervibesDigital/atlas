import { describe, it, expect } from "vitest";
import { ExperimentLab } from "../src/index";

describe("ExperimentLab", () => {
  it("picks the higher-converting variant once there's enough data", () => {
    const lab = new ExperimentLab();
    const exp = lab.start("hook test", ["bold-claim", "question"]);
    // bold-claim: 8/10 win; question: 3/10 win
    for (let i = 0; i < 10; i++) lab.record(exp.id, "bold-claim", i < 8);
    for (let i = 0; i < 10; i++) lab.record(exp.id, "question", i < 3);
    expect(lab.evaluate(exp.id, 10)).toBe("bold-claim");
    expect(lab.get(exp.id)!.status).toBe("decided");
  });

  it("won't decide before minimum trials", () => {
    const lab = new ExperimentLab();
    const exp = lab.start("t", ["a", "b"]);
    lab.record(exp.id, "a", true);
    expect(lab.evaluate(exp.id, 10)).toBeNull();
  });

  it("requires at least two variants", () => {
    expect(() => new ExperimentLab().start("bad", ["only"])).toThrow(/at least 2/);
  });
});
