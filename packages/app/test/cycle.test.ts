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

  it("enqueues the Reel's render with a publishInput, so a finished render can request approval later", async () => {
    const { mkdtemp, rm, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "atlas-cycle-test-"));
    const videoJobsFile = join(dir, "video-jobs.json");

    try {
      await runDailyCycle({
        memoryStore: new InMemoryStore(),
        approvalsGateway: new ApprovalGateway(),
        metricsTracker: new MetricsTracker(),
        brainAdapters: [new StubAdapter()],
        renderer: new NoOpRenderer(),
        videoJobsFile,
        healEnabled: false,
      });

      const raw = await readFile(videoJobsFile, "utf8");
      const jobs = JSON.parse(raw) as Array<{ publishInput?: { personaHandle?: string; caption?: string } }>;
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.publishInput).toBeTruthy();
      expect(jobs[0]!.publishInput!.personaHandle).toBeTruthy();
      expect(jobs[0]!.publishInput!.caption).toBeTruthy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
    // Asserting an exact total count here was already fragile — this cycle
    // calls the real (unmocked) search.scout(), which can itself file an
    // approval for a genuinely popular repo it finds live on GitHub. Check
    // for the SPECIFIC publish approval instead of the whole list's size, so
    // this test only fails if publishing itself breaks, not because some
    // other business also had something worth approving that day.
    const publishApproval = report.pendingApprovals.find((a) => (a as { id?: string }).id === report.publish.approvalId);
    expect(publishApproval).toBeTruthy();
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
    // A cycle step calling a service the orchestrator's own manifest hasn't
    // granted itself permission for (a real bug found and fixed in this
    // session — twice) must never ship silently: it fails every cycle,
    // forever, with no signal beyond a cycleHealth entry nobody reads. Any
    // "not in permissions" failure here means a newly-wired service is
    // missing its call:<service> grant in orchestrator/src/plugin.ts.
    for (const failure of cycleHealth.failures) {
      expect(failure.error).not.toMatch(/not in permissions/);
    }
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
    // Observed real runtime is ~7s locally (this repo typechecks clean, so
    // healing finds nothing to fix); 200s gives generous margin for slower
    // CI/typecheck variance.
    { timeout: 200_000 },
  );
});
