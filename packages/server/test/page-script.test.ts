import { describe, it, expect } from "vitest";
import { PAGE } from "../src/html";

describe("panel page", () => {
  it("has a syntactically valid inline script (guards the whole UI)", () => {
    const m = PAGE.match(/<script>([\s\S]*?)<\/script>/);
    expect(m).toBeTruthy();
    // new Function() PARSES the script (without running it) — it throws a
    // SyntaxError if the inline JS is broken, which would otherwise silently
    // freeze the entire control panel.
    expect(() => new Function(m![1]!)).not.toThrow();
  });
});
