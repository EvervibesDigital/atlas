import type { RiskLevel } from "@atlas/core";

/**
 * Executive types. The Executive turns an objective + steps into an ordered,
 * risk-tagged Plan. It PLANS ONLY — it never runs tasks (the Guardian enforces
 * that its `planner` role cannot execute).
 */
export type TaskStatus = "blocked" | "ready" | "dispatched" | "pending_approval" | "done";

/** A step as submitted by a caller. */
export interface StepInput {
  /** Optional stable id; auto-assigned (t1, t2, …) if omitted. */
  id?: string;
  description: string;
  risk: RiskLevel;
  /** Ids of steps that must finish first. */
  dependsOn?: string[];
}

export interface Task {
  id: string;
  description: string;
  risk: RiskLevel;
  dependsOn: string[];
  status: TaskStatus;
}

export interface Plan {
  id: string;
  objective: string;
  /** Tasks in dependency order (topologically sorted). */
  tasks: Task[];
  createdAt: string;
}
