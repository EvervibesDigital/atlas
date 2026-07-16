import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Gig, GigCandidate, GigStats, GigStatus } from "./types";
import { dedupeKey } from "./matching";

/** GigRegistry — the job queue + bid history. Persisted to JSON, same pattern as BusinessRegistry. */
export class GigRegistry {
  private items: Gig[] = [];
  private loaded = false;

  constructor(private file?: string) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file) return;
    try {
      this.items = JSON.parse(await readFile(this.file, "utf8")) as Gig[];
    } catch {
      this.items = [];
    }
  }

  private async persist(): Promise<void> {
    if (!this.file) return;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.items, null, 2), "utf8");
  }

  /** Add candidates, skipping any that dedupe against an existing entry. Returns only the newly-added gigs. */
  async addCandidates(candidates: GigCandidate[]): Promise<Gig[]> {
    await this.load();
    const existingKeys = new Set(this.items.map((g) => g.dedupeKey));
    const added: Gig[] = [];
    for (const c of candidates) {
      const key = dedupeKey(c.title, c.snippet);
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      const gig: Gig = {
        id: randomUUID(),
        source: c.source,
        title: c.title,
        url: c.url,
        snippet: c.snippet,
        budget: c.budget,
        foundAt: new Date().toISOString(),
        status: "new",
        dedupeKey: key,
      };
      this.items.push(gig);
      added.push(gig);
    }
    if (added.length) await this.persist();
    return added;
  }

  async list(status?: GigStatus): Promise<Gig[]> {
    await this.load();
    const items = status ? this.items.filter((g) => g.status === status) : [...this.items];
    return items.sort((a, b) => b.foundAt.localeCompare(a.foundAt));
  }

  async get(id: string): Promise<Gig | undefined> {
    await this.load();
    return this.items.find((g) => g.id === id);
  }

  async update(id: string, patch: Partial<Gig>): Promise<Gig | undefined> {
    await this.load();
    const g = this.items.find((x) => x.id === id);
    if (!g) return undefined;
    Object.assign(g, patch);
    await this.persist();
    return g;
  }

  async stats(): Promise<GigStats> {
    await this.load();
    const s: GigStats = { new: 0, approved: 0, submitted: 0, responded: 0, completed: 0, paid: 0, rejected: 0, totalEarned: 0 };
    for (const g of this.items) {
      s[g.status]++;
      if (g.status === "paid" && g.paidAmount) s.totalEarned += g.paidAmount;
    }
    return s;
  }
}
