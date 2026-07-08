import { describe, it, expect } from "vitest";
import { classify } from "../src/index";

describe("classify", () => {
  it("classifies a bug with elevated risk", () => {
    const c = classify({ title: "Fix crash on empty script" });
    expect(c.type).toBe("bug");
    expect(c.risk).toBe(2);
  });

  it("classifies a feature", () => {
    const c = classify({ title: "Add login page" });
    expect(c.type).toBe("feature");
  });

  it("treats security work as highest risk", () => {
    const c = classify({ title: "Rotate leaked credential token" });
    expect(c.type).toBe("security");
    expect(c.risk).toBe(3);
  });

  it("bumps risk for anything touching production/database", () => {
    const c = classify({ title: "Refactor the production database migration" });
    expect(c.risk).toBeGreaterThanOrEqual(2);
  });
});
