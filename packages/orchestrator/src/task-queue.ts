import { EventEmitter } from "node:events";

/** Risk level determines whether a task pauses for owner approval. */
export type RiskLevel = "low" | "medium" | "high";

/** Task status progression. */
export type TaskStatus = "pending" | "approved" | "executing" | "completed" | "failed" | "rejected";

/** One job in the queue. */
export interface Task {
  id: string;
  name: string; // human-readable task name
  description: string; // what it does
  riskLevel: RiskLevel; // low=no approval needed, high=always ask
  status: TaskStatus;
  progress: number; // 0–100
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  output?: unknown; // result or error message
  error?: string; // failure reason
}

/** Approval request for high-risk tasks. */
export interface ApprovalRequest {
  taskId: string;
  taskName: string;
  description: string;
  riskLevel: RiskLevel;
  ts: number;
}

/**
 * Async task queue: runs multiple jobs in parallel, each pausing for approval
 * on risky actions. Emits events as tasks progress. Max 5 concurrent workers.
 */
export class TaskQueue extends EventEmitter {
  private tasks = new Map<string, Task>();
  private pending: string[] = [];
  private executing = new Set<string>();
  private approved = new Set<string>();
  private rejected = new Set<string>();
  private workers = 0;
  private maxWorkers = 5;

  constructor() {
    super();
  }

  /** Submit a job; returns its ID immediately. */
  submit(name: string, description: string, riskLevel: RiskLevel = "low"): string {
    const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const task: Task = {
      id,
      name,
      description,
      riskLevel,
      status: "pending",
      progress: 0,
      createdAt: Date.now(),
    };
    this.tasks.set(id, task);
    this.pending.push(id);
    this.emit("task.created", task);
    this.process(); // start processing if workers available
    return id;
  }

  /** Approve a task for execution (owner says "yes"). */
  async approve(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("no such task");
    if (task.status !== "pending") throw new Error("task is not pending");
    this.approved.add(taskId);
    task.status = "approved";
    this.emit("task.approved", task);
    this.process();
  }

  /** Reject a task (owner says "no"). */
  reject(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("no such task");
    if (task.status !== "pending") throw new Error("task is not pending");
    this.rejected.add(taskId);
    task.status = "rejected";
    this.emit("task.rejected", task);
  }

  /** Get a single task. */
  get(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  /** List all tasks, newest first. */
  list(): Task[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Pending tasks awaiting approval. */
  pendingApprovals(): ApprovalRequest[] {
    const out: ApprovalRequest[] = [];
    for (const id of this.pending) {
      const t = this.tasks.get(id);
      if (t && t.riskLevel !== "low" && !this.approved.has(id) && !this.rejected.has(id)) {
        out.push({ taskId: t.id, taskName: t.name, description: t.description, riskLevel: t.riskLevel, ts: t.createdAt });
      }
    }
    return out;
  }

  /** Update a task's progress (0–100). Called by the executor. */
  setProgress(taskId: string, progress: number): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.progress = Math.min(100, Math.max(0, progress));
      this.emit("task.progress", { id: taskId, progress: task.progress });
    }
  }

  /** Mark a task as completed with optional output. */
  complete(taskId: string, output?: unknown): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = "completed";
      task.completedAt = Date.now();
      task.progress = 100;
      task.output = output;
      this.executing.delete(taskId);
      this.emit("task.completed", task);
      this.process();
    }
  }

  /** Mark a task as failed with an error message. */
  fail(taskId: string, error: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = "failed";
      task.completedAt = Date.now();
      task.error = error;
      this.executing.delete(taskId);
      this.emit("task.failed", task);
      this.process();
    }
  }

  /** Internal: process the queue — start executing tasks if workers available. */
  private process(): void {
    // If high-risk task is pending approval, don't auto-start it.
    while (this.workers < this.maxWorkers && this.pending.length > 0) {
      const taskId = this.pending.shift()!;
      const task = this.tasks.get(taskId);
      if (!task) continue;

      // If high-risk and not approved, skip (owner will approve later).
      if (task.riskLevel !== "low" && !this.approved.has(taskId)) {
        this.emit("task.awaiting_approval", {
          taskId: task.id,
          name: task.name,
          riskLevel: task.riskLevel,
        });
        break; // Don't start lower-priority tasks until this approval is resolved.
      }

      // Rejected tasks are skipped.
      if (this.rejected.has(taskId)) {
        task.status = "rejected";
        this.emit("task.rejected", task);
        continue;
      }

      // Start executing this task.
      this.executing.add(taskId);
      task.status = "executing";
      task.startedAt = Date.now();
      this.workers++;
      this.emit("task.started", task);
      // The executor is responsible for calling .complete() or .fail() when done.
      // We just track that a worker slot is in use.
    }
  }
}
