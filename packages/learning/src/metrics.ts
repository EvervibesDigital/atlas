import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { CategoryMetrics, Outcome } from "./types";

interface Counts {
  successes: number;
  failures: number;
}

function toMetrics(category: string, c: Counts): CategoryMetrics {
  const total = c.successes + c.failures;
  return {
    category,
    successes: c.successes,
    failures: c.failures,
    total,
    successRate: total ? c.successes / total : 0,
    // Laplace smoothing: starts at 0.5 with no data, moves with evidence.
    confidence: (c.successes + 1) / (total + 2),
  };
}

/**
 * MetricsTracker — success/failure counts per category, with a smoothed
 * confidence. Optionally persists to a JSON file so ATLAS keeps learning across
 * restarts.
 */
export class MetricsTracker {
  private counts = new Map<string, Counts>();
  private loaded = false;

  constructor(private file?: string) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file) return;
    try {
      const obj = JSON.parse(await readFile(this.file, "utf8")) as Record<string, Counts>;
      this.counts = new Map(Object.entries(obj));
    } catch {
      /* first run — no file yet */
    }
  }

  private async persist(): Promise<void> {
    if (!this.file) return;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(Object.fromEntries(this.counts), null, 2), "utf8");
  }

  async record(category: string, outcome: Outcome): Promise<void> {
    await this.load();
    const c = this.counts.get(category) ?? { successes: 0, failures: 0 };
    if (outcome === "success") c.successes++;
    else c.failures++;
    this.counts.set(category, c);
    await this.persist();
  }

  async get(category: string): Promise<CategoryMetrics> {
    await this.load();
    return toMetrics(category, this.counts.get(category) ?? { successes: 0, failures: 0 });
  }

  async all(): Promise<CategoryMetrics[]> {
    await this.load();
    return [...this.counts.entries()].map(([k, v]) => toMetrics(k, v));
  }
}
