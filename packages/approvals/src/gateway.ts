import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { RiskLevel } from "@atlas/core";
import type { Approval, ApprovalStatus } from "./types";

/**
 * ApprovalGateway — stores pending decisions and resolves them. Optionally
 * persists to a JSON file so the approval queue survives restarts (the daily
 * list can't vanish because a laptop slept).
 */
export class ApprovalGateway {
  private items: Approval[] = [];
  private loaded = false;

  constructor(private file?: string) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file) return;
    try {
      this.items = JSON.parse(await readFile(this.file, "utf8")) as Approval[];
    } catch {
      this.items = [];
    }
  }

  private async persist(): Promise<void> {
    if (!this.file) return;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.items, null, 2), "utf8");
  }

  async request(input: { action: string; detail?: string; risk: RiskLevel }): Promise<Approval> {
    await this.load();
    const approval: Approval = {
      id: randomUUID(),
      action: input.action,
      detail: input.detail,
      risk: input.risk,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.items.push(approval);
    await this.persist();
    return approval;
  }

  async list(status?: ApprovalStatus): Promise<Approval[]> {
    await this.load();
    return status ? this.items.filter((a) => a.status === status) : [...this.items];
  }

  /** Resolve a pending approval. Returns undefined if missing or already decided. */
  async decide(id: string, status: "approved" | "rejected"): Promise<Approval | undefined> {
    await this.load();
    const approval = this.items.find((a) => a.id === id);
    if (!approval || approval.status !== "pending") return undefined;
    approval.status = status;
    approval.decidedAt = new Date().toISOString();
    await this.persist();
    return approval;
  }
}
