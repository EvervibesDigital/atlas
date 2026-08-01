import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Lead, LeadStatus, ScanResult } from "./types";
import type { FoundLead } from "./leadfinder";

function dedupeKey(businessName: string, website: string): string {
  const norm = (s: string) => s.toLowerCase().trim();
  return createHash("md5").update(`${norm(businessName)}|${norm(website)}`).digest("hex");
}

/** LeadRegistry — the lead-scan queue, persisted to JSON. Same pattern as GigRegistry. */
export class LeadRegistry {
  private items: Lead[] = [];
  private loaded = false;

  constructor(private file?: string) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file) return;
    try {
      this.items = JSON.parse(await readFile(this.file, "utf8")) as Lead[];
    } catch {
      this.items = [];
    }
  }

  private async persist(): Promise<void> {
    if (!this.file) return;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.items, null, 2), "utf8");
  }

  /** Add found leads, skipping any that dedupe against an existing entry. Returns only the newly-added leads. */
  async addFound(niche: string, city: string, found: FoundLead[]): Promise<Lead[]> {
    await this.load();
    const existingKeys = new Set(this.items.map((l) => l.dedupeKey));
    const added: Lead[] = [];
    for (const f of found) {
      if (!f.website) continue;
      const key = dedupeKey(f.businessName, f.website);
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      const lead: Lead = {
        id: randomUUID(),
        businessName: f.businessName,
        website: f.website,
        phone: f.phone,
        email: f.email,
        city,
        niche,
        status: "new",
        foundAt: new Date().toISOString(),
        dedupeKey: key,
      };
      this.items.push(lead);
      added.push(lead);
    }
    if (added.length) await this.persist();
    return added;
  }

  async attachScan(id: string, scan: ScanResult): Promise<Lead | undefined> {
    await this.load();
    const lead = this.items.find((l) => l.id === id);
    if (!lead) return undefined;
    lead.scan = scan;
    // Promote a contact address found during the scan onto the lead itself,
    // since that is what approve() hands to the outreach workflow. Never
    // overwrite an address we already had — a directory-sourced one is more
    // trustworthy than one scraped off the page.
    if (!lead.email && scan.contactEmail) lead.email = scan.contactEmail;
    await this.persist();
    return lead;
  }

  async list(status?: LeadStatus): Promise<Lead[]> {
    await this.load();
    const items = status ? this.items.filter((l) => l.status === status) : [...this.items];
    return items.sort((a, b) => b.foundAt.localeCompare(a.foundAt));
  }

  async get(id: string): Promise<Lead | undefined> {
    await this.load();
    return this.items.find((l) => l.id === id);
  }

  async update(id: string, patch: Partial<Lead>): Promise<Lead | undefined> {
    await this.load();
    const lead = this.items.find((l) => l.id === id);
    if (!lead) return undefined;
    Object.assign(lead, patch);
    await this.persist();
    return lead;
  }
}
