import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/test/**/*.test.ts"],
    // Default (5000ms) is too tight for this suite's real HTTP round-trips
    // and real Atlas builds under full-suite CPU contention — a single slow
    // test (a real end-to-end cycle run, ~25-35s) can starve otherwise-fast
    // tests in the same file past the default and fail them intermittently,
    // not because they're actually broken. 15s gives real integration tests
    // headroom; genuinely long-running tests still set their own explicit
    // override on top of this (see packages/server/test/server.test.ts).
    testTimeout: 15000,
  },
});
