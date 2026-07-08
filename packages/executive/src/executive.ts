import { randomUUID } from "node:crypto";
import type { Plan, StepInput, Task } from "./types";

/**
 * Executive — decomposes an objective into an ordered Plan.
 *
 * Ordering is a real topological sort with validation: unknown dependencies and
 * dependency cycles are rejected up front, so a plan is never silently broken.
 */
export class Executive {
  decompose(objective: string, steps: StepInput[]): Plan {
    const tasks: Task[] = steps.map((s, i) => ({
      id: s.id ?? `t${i + 1}`,
      description: s.description,
      risk: s.risk,
      dependsOn: s.dependsOn ?? [],
      status: "blocked",
    }));

    const ordered = topoSort(tasks);
    for (const t of ordered) t.status = t.dependsOn.length === 0 ? "ready" : "blocked";

    return { id: randomUUID(), objective, tasks: ordered, createdAt: new Date().toISOString() };
  }

  /** Tasks that can start now (no unmet dependencies). */
  readyTasks(plan: Plan): Task[] {
    return plan.tasks.filter((t) => t.status === "ready");
  }
}

/** Kahn's algorithm with unknown-dependency + cycle detection. */
function topoSort(tasks: Task[]): Task[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (!byId.has(d)) throw new Error(`executive: task "${t.id}" depends on unknown task "${d}"`);
    }
  }

  const indegree = new Map(tasks.map((t) => [t.id, t.dependsOn.length]));
  const dependents = new Map<string, string[]>();
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      const list = dependents.get(d) ?? [];
      list.push(t.id);
      dependents.set(d, list);
    }
  }

  const queue = tasks.filter((t) => indegree.get(t.id) === 0).map((t) => t.id);
  const out: Task[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    out.push(byId.get(id)!);
    for (const dep of dependents.get(id) ?? []) {
      const next = (indegree.get(dep) ?? 0) - 1;
      indegree.set(dep, next);
      if (next === 0) queue.push(dep);
    }
  }

  if (out.length !== tasks.length) throw new Error("executive: dependency cycle detected");
  return out;
}
