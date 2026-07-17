import { describe, it, expect } from "vitest";
import { AuditLog } from "../src/audit";

describe("AuditLog.query", () => {
  it("filters entries by actor, status, and time range", async () => {
    const log = new AuditLog();
    await log.record({ id: "1", actor: "cfo", action: "invoke:cfo", decision: "allow", status: "done" });
    await log.record({ id: "2", actor: "gigfinder", action: "invoke:gigfinder", decision: "allow", status: "failed" });
    await log.record({ id: "3", actor: "cfo", action: "invoke:cfo", decision: "allow", status: "running" });

    expect(await log.query({ actor: "cfo" })).toHaveLength(2);
    expect(await log.query({ status: "failed" })).toHaveLength(1);
    expect(await log.query({ actor: "cfo", status: "running" })).toHaveLength(1);
    expect(await log.query({})).toHaveLength(3);
  });

  it("filters by since/until against the entry timestamp", async () => {
    const log = new AuditLog();
    await log.record({ id: "1", actor: "cfo", action: "x", decision: "allow" });
    await new Promise((r) => setTimeout(r, 2));
    const midpoint = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 2));
    await log.record({ id: "2", actor: "cfo", action: "y", decision: "allow" });

    expect(await log.query({ since: midpoint })).toHaveLength(1);
    expect(await log.query({ until: midpoint })).toHaveLength(1);
  });
});
