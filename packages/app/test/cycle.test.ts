import { describe, it, expect } from "vitest";
import { InMemoryStore } from "@atlas/memory";
import { ApprovalGateway } from "@atlas/approvals";
import { MetricsTracker } from "@atlas/learning";
import { StubAdapter } from "@atlas/brain";
import { NoOpRenderer } from "@atlas/publishing";
import { runDailyCycle } from "../src/cycle";

/**
 * The autonomous loop, end to end. One call runs a full day of ATLAS's work
 * across every department — offline, posting nothing.
 */
describe("autonomous daily cycle", () => {
  it("drafts a Reel, consults the council, and produces a morning report", async () => {
    const report = await runDailyCycle({
      memoryStore: new InMemoryStore(),
      approvalsGateway: new ApprovalGateway(),
      metricsTracker: new MetricsTracker(),
      brainAdapters: [new StubAdapter()],
      renderer: new NoOpRenderer(),
      healEnabled: false,
    });

    expect(report.topic).toBeTruthy();
    expect(report.reel.hook.length).toBeGreaterThan(0);
    expect(report.council?.consensus).toBeTruthy();
    // No rendered MP4 was supplied (NoOpRenderer renders nothing), so
    // publishing waits for the render step.
    expect(report.publish.status).toBe("pending-render");
    expect(Array.isArray(report.pendingApprovals)).toBe(true);
  });

  it("queues an approval when a rendered video is supplied (still posts nothing)", async () => {
    const report = await runDailyCycle({
      memoryStore: new InMemoryStore(),
      approvalsGateway: new ApprovalGateway(),
      metricsTracker: new MetricsTracker(),
      brainAdapters: [new StubAdapter()],
      videoRef: "rendered/today.mp4",
      healEnabled: false,
    });

    expect(report.publish.status).toBe("pending-approval");
    expect(report.pendingApprovals.length).toBe(1);
  });

  it("reports cycleHealth alongside the rest of the report", async () => {
    const report = await runDailyCycle({
      memoryStore: new InMemoryStore(),
      approvalsGateway: new ApprovalGateway(),
      metricsTracker: new MetricsTracker(),
      brainAdapters: [new StubAdapter()],
      renderer: new NoOpRenderer(),
      healEnabled: false,
    });

    expect(report.cycleHealth).toBeTruthy();
    const cycleHealth = report.cycleHealth!;
    expect(typeof cycleHealth.succeeded).toBe("number");
    expect(typeof cycleHealth.failed).toBe("number");
    expect(Array.isArray(cycleHealth.failures)).toBe(true);
    // succeeded/failed should account for every optional() call actually made.
    expect(cycleHealth.succeeded + cycleHealth.failed).toBeGreaterThan(0);
  });

  it(
    "runs self-healing when enabled and reports the outcome",
    async () => {
      const report = await runDailyCycle({
        memoryStore: new InMemoryStore(),
        approvalsGateway: new ApprovalGateway(),
        metricsTracker: new MetricsTracker(),
        brainAdapters: [new StubAdapter()],
        renderer: new NoOpRenderer(),
        healEnabled: true,
      });

      // This repo should typecheck cleanly, so healing finds nothing to fix —
      // this test proves the WIRING (the step ran and its result reached the
      // report), not the fix-generation logic itself (covered by
      // packages/codebase/test/healer.test.ts with fast fake commands).
      if (report.healReport) {
        expect(typeof report.healReport.healed).toBe("number");
        expect(typeof report.healReport.attempted).toBe("number");
        expect(typeof report.healReport.total).toBe("number");
      }
      // Either it ran (healReport present) or it failed/timed out and shows
      // up in cycleHealth.failures instead — never both silent.
      const healFailed = report.cycleHealth?.failures.some((f) => f.step === "codebase");
      expect(report.healReport !== undefined || healFailed).toBe(true);
    },
    { timeout: 200_000 },
  );
});
