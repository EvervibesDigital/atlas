import { describe, it, expect } from "vitest";
import { Executive } from "../src/executive";

describe("Executive.decompose", () => {
  it("orders tasks so dependencies come first", () => {
    const ex = new Executive();
    const plan = ex.decompose("ship feature", [
      { id: "B", description: "publish", risk: 2, dependsOn: ["A"] },
      { id: "A", description: "write", risk: 0 },
    ]);
    const order = plan.tasks.map((t) => t.id);
    expect(order.indexOf("A")).toBeLessThan(order.indexOf("B"));
  });

  it("marks only dependency-free tasks ready", () => {
    const ex = new Executive();
    const plan = ex.decompose("x", [
      { id: "A", description: "a", risk: 0 },
      { id: "B", description: "b", risk: 0, dependsOn: ["A"] },
    ]);
    expect(ex.readyTasks(plan).map((t) => t.id)).toEqual(["A"]);
  });

  it("auto-assigns ids when omitted", () => {
    const ex = new Executive();
    const plan = ex.decompose("x", [{ description: "only", risk: 0 }]);
    expect(plan.tasks[0]!.id).toBe("t1");
  });

  it("rejects an unknown dependency", () => {
    const ex = new Executive();
    expect(() => ex.decompose("x", [{ id: "A", description: "a", risk: 0, dependsOn: ["ghost"] }])).toThrow(/unknown task/);
  });

  it("rejects a dependency cycle", () => {
    const ex = new Executive();
    expect(() =>
      ex.decompose("x", [
        { id: "A", description: "a", risk: 0, dependsOn: ["B"] },
        { id: "B", description: "b", risk: 0, dependsOn: ["A"] },
      ]),
    ).toThrow(/cycle/);
  });
});
