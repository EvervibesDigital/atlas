import { describe, it, expect } from "vitest";
import { checkCompliance } from "../src/index";

describe("checkCompliance", () => {
  it("flags an unsubstantiated income guarantee", () => {
    const v = checkCompliance("This system gives you guaranteed income every month!");
    expect(v.some((x) => x.rule === "income-claim")).toBe(true);
  });

  it("flags promotional content missing #ad", () => {
    const v = checkCompliance("Loving this sponsored product, link in bio");
    expect(v.some((x) => x.rule === "disclosure")).toBe(true);
  });

  it("passes clean, honest content", () => {
    const v = checkCompliance("Here are three free AI tools I actually use. #ai #tools");
    expect(v).toHaveLength(0);
  });
});
