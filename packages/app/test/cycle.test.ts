import { describe, it, expect } from "vitest";
import { InMemoryStore } from "@atlas/memory";
import { ApprovalGateway } from "@atlas/approvals";
import { MetricsTracker } from "@atlas/learning";
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
    });

    expect(report.topic).toBeTruthy();
    expect(report.reel.hook.length).toBeGreaterThan(0);
    expect(report.council?.consensus).toBeTruthy();
    // No rendered MP4 was supplied, so publishing waits for the render step.
    expect(report.publish.status).toBe("pending-render");
    expect(Array.isArray(report.pendingApprovals)).toBe(true);
  });

  it("queues an approval when a rendered video is supplied (still posts nothing)", async () => {
    const report = await runDailyCycle({
      memoryStore: new InMemoryStore(),
      approvalsGateway: new ApprovalGateway(),
      metricsTracker: new MetricsTracker(),
      videoRef: "rendered/today.mp4",
    });

    expect(report.publish.status).toBe("pending-approval");
    expect(report.pendingApprovals.length).toBe(1);
  });
});
