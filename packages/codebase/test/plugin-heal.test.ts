import { describe, it, expect, vi, beforeEach } from "vitest";
import { Atlas, type GuardianLike } from "@atlas/core";
import type { CodeError, HealAttempt } from "../src/healer";

// generateAndApplyFix (from healer.ts, already covered end-to-end by
// healer.test.ts) is mocked here so we can force it to throw for one call —
// the plugin's `heal` op is responsible for surviving that (see plugin.ts's
// try/catch around the call), not for reproducing the internal failure mode
// that causes it. vi.hoisted is required because vi.mock's factory is
// hoisted above these imports, so the mock fns must exist before that point.
const { detectErrorsMock, generateAndApplyFixMock } = vi.hoisted(() => ({
  detectErrorsMock: vi.fn(),
  generateAndApplyFixMock: vi.fn(),
}));

vi.mock("../src/healer", () => ({
  detectErrors: detectErrorsMock,
  generateAndApplyFix: generateAndApplyFixMock,
}));

const { createCodebasePlugin } = await import("../src/plugin");

function permissiveGuardian(): GuardianLike {
  return {
    grant: () => {},
    check: () => ({ decision: "allow", reason: "test" }),
  };
}

describe("codebase plugin heal op — throw-safety around generateAndApplyFix", () => {
  beforeEach(() => {
    detectErrorsMock.mockReset();
    generateAndApplyFixMock.mockReset();
  });

  it("records a throwing attempt as generate_failed, keeps the loop going, and still emits/returns", async () => {
    const err1: CodeError = { type: "typecheck", file: "a.ts", message: "boom a" };
    const err2: CodeError = { type: "typecheck", file: "b.ts", message: "boom b" };
    detectErrorsMock.mockResolvedValue([err1, err2]);

    // First attempt throws uncaught — mirrors generateAndApplyFix's own
    // rollback write failing (disk full / permissions / AV lock / file
    // deleted mid-run), which today propagates past its own try/catch.
    generateAndApplyFixMock
      .mockRejectedValueOnce(new Error("EPERM: rollback write failed"))
      .mockResolvedValueOnce({ error: err2, outcome: "skipped", detail: "unrelated skip" } satisfies HealAttempt);

    const atlas = new Atlas({ guardian: permissiveGuardian() });
    await atlas.use(createCodebasePlugin());

    let emitted: unknown;
    atlas.events.on("codebase.healed", (payload) => {
      emitted = payload;
    });

    const result = (await atlas.invoke("codebase", { op: "heal", dir: "/fake/repo" })) as {
      healed: number;
      attempted: number;
      total: number;
      attempts: HealAttempt[];
    };

    // The op itself must not throw, and both errors must have been attempted
    // — the throw on the first one must not swallow the second's result.
    expect(generateAndApplyFixMock).toHaveBeenCalledTimes(2);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]!.outcome).toBe("generate_failed");
    expect(result.attempts[0]!.detail).toContain("EPERM: rollback write failed");
    expect(result.attempts[0]!.error).toEqual(err1);
    expect(result.attempts[1]!.outcome).toBe("skipped");
    expect(result.healed).toBe(0);
    expect(result.attempted).toBe(2);
    expect(result.total).toBe(2);

    // The emit must still fire with the accurate counts, not be skipped
    // because one attempt threw.
    expect(emitted).toEqual({ healed: 0, attempted: 2, total: 2 });
  });
});
