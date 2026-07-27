import { describe, it, expect } from "vitest";
import { PAGE, MOBILE_BRIEF_PAGE } from "../src/html";

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

describe("mobile brief page", () => {
  it("has a syntactically valid inline script", () => {
    const m = MOBILE_BRIEF_PAGE.match(/<script>([\s\S]*?)<\/script>/);
    expect(m).toBeTruthy();
    expect(() => new Function(m![1]!)).not.toThrow();
  });

  it("keeps error toasts on screen (no auto-hide timer) so they can actually be read/copied", () => {
    // Regression guard for the bug where an approve/reject failure flashed
    // for 1.8s with pointer-events:none — unreadable and uncopyable on
    // mobile. The error branch of toast() must NOT schedule a hide timeout.
    const scriptMatch = MOBILE_BRIEF_PAGE.match(/<script>([\s\S]*?)<\/script>/)![1]!;
    const toastFnMatch = scriptMatch.match(/function toast\(msg, isErr\)\{[\s\S]*?\n\}/);
    expect(toastFnMatch).toBeTruthy();
    const toastFnSrc = toastFnMatch![0]!;
    const ifErrBranch = toastFnSrc.slice(toastFnSrc.indexOf("if(isErr){"), toastFnSrc.indexOf("} else {"));
    expect(ifErrBranch).not.toContain("setTimeout");
  });

  it("gives error toasts pointer-events so the text can be tapped/selected", () => {
    expect(MOBILE_BRIEF_PAGE).toContain(".toast.err{pointer-events:auto");
  });
});
