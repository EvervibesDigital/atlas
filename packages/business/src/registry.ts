import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * BusinessRegistry — the list of Mat's actual businesses (up to as many as he
 * has). Persisted to JSON so it survives restarts. ATLAS researches each one
 * (via the web reader) and rotates through them so it keeps learning them over
 * time.
 */
export type BusinessStage = "idea" | "building" | "running" | "improving";

export interface Business {
  id: string;
  name: string;
  url?: string;
  goal: string;
  stage: BusinessStage;
  lastResearchedAt?: string;
}

export interface BusinessInput {
  name: string;
  url?: string;
  goal?: string;
  stage?: BusinessStage;
}

export class BusinessRegistry {
  private items: Business[] = [];
  private loaded = false;

  constructor(private file?: string) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file) return;
    try {
      this.items = JSON.parse(await readFile(this.file, "utf8")) as Business[];
    } catch {
      this.items = [];
    }
  }

  private async persist(): Promise<void> {
    if (!this.file) return;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.items, null, 2), "utf8");
  }

  async add(input: BusinessInput): Promise<Business> {
    await this.load();
    const b: Business = { id: randomUUID(), name: input.name, url: input.url, goal: input.goal ?? "", stage: input.stage ?? "idea" };
    this.items.push(b);
    await this.persist();
    return b;
  }

  async list(): Promise<Business[]> {
    await this.load();
    return [...this.items];
  }

  async get(id: string): Promise<Business | undefined> {
    await this.load();
    return this.items.find((b) => b.id === id);
  }

  async markResearched(id: string): Promise<void> {
    await this.load();
    const b = this.items.find((x) => x.id === id);
    if (b) {
      b.lastResearchedAt = new Date().toISOString();
      await this.persist();
    }
  }

  /** The business that hasn't been researched in the longest time (or ever). */
  async nextToResearch(): Promise<Business | undefined> {
    await this.load();
    const withUrl = this.items.filter((b) => b.url);
    if (withUrl.length === 0) return undefined;
    return withUrl.sort((a, b) => (a.lastResearchedAt ?? "").localeCompare(b.lastResearchedAt ?? ""))[0];
  }
}
