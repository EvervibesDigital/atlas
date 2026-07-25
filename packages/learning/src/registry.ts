import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

interface HandledEntry {
  status: "accepted" | "dismissed";
  at: string;
}

/**
 * ProposalRegistry — tracks which proposal categories Mat has already
 * adopted or dismissed, persisted to JSON. Same load/persist pattern as
 * LeadRegistry/GigRegistry. Proposals themselves are recomputed live from
 * metrics on every call (see proposals.ts); this registry is only the
 * "already handled, don't show again" suppression list.
 */
export class ProposalRegistry {
  private handled = new Map<string, HandledEntry>();
  private loaded = false;

  constructor(private file?: string) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file) return;
    try {
      const obj = JSON.parse(await readFile(this.file, "utf8")) as Record<string, HandledEntry>;
      this.handled = new Map(Object.entries(obj));
    } catch {
      /* first run — no file yet */
    }
  }

  private async persist(): Promise<void> {
    if (!this.file) return;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(Object.fromEntries(this.handled), null, 2), "utf8");
  }

  async handledCategories(): Promise<Set<string>> {
    await this.load();
    return new Set(this.handled.keys());
  }

  async markHandled(category: string, status: "accepted" | "dismissed"): Promise<void> {
    await this.load();
    this.handled.set(category, { status, at: new Date().toISOString() });
    await this.persist();
  }
}
