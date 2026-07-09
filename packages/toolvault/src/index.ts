import type { Plugin } from "@atlas/core";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * AI Vault — ATLAS's memory of the software & websites available to it. For any
 * job, `best` returns the HIGHEST-QUALITY tool in that category that is FREE or
 * has been APPROVED for a subscription — so ATLAS always reaches for the best
 * option it's allowed to use, and never silently signs Mat up for a paid tool.
 */
export interface Tool {
  id: string;
  name: string;
  category: string;
  url?: string;
  /** 1 (poor) … 5 (excellent). */
  quality: number;
  free: boolean;
  /** For paid tools: has Mat approved paying for it? */
  approved: boolean;
  monthlyCost?: number;
  notes?: string;
}

export type ToolInput = Omit<Tool, "id" | "approved"> & { approved?: boolean };

/** Usable = free, or paid-but-approved. */
export function usable(t: Tool): boolean {
  return t.free || t.approved;
}

export function bestFor(tools: Tool[], category: string): Tool | null {
  const candidates = tools.filter((t) => t.category.toLowerCase() === category.toLowerCase() && usable(t));
  if (candidates.length === 0) return null;
  // Highest quality; tie-break preferring free.
  return candidates.sort((a, b) => b.quality - a.quality || Number(b.free) - Number(a.free))[0]!;
}

export class ToolVault {
  private items: Tool[] = [];
  private loaded = false;
  constructor(private file?: string) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file) return;
    try {
      this.items = JSON.parse(await readFile(this.file, "utf8")) as Tool[];
    } catch {
      this.items = [];
    }
  }
  private async persist(): Promise<void> {
    if (!this.file) return;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.items, null, 2), "utf8");
  }

  async add(input: ToolInput): Promise<Tool> {
    await this.load();
    const tool: Tool = { id: randomUUID(), approved: input.approved ?? false, ...input, quality: Math.max(1, Math.min(5, input.quality)) };
    this.items.push(tool);
    await this.persist();
    return tool;
  }
  async list(): Promise<Tool[]> {
    await this.load();
    return [...this.items];
  }
  async approve(id: string, approved = true): Promise<Tool | undefined> {
    await this.load();
    const t = this.items.find((x) => x.id === id);
    if (!t) return undefined;
    t.approved = approved;
    await this.persist();
    return t;
  }
  async best(category: string): Promise<Tool | null> {
    await this.load();
    return bestFor(this.items, category);
  }
}

export type ToolVaultCommand =
  | { op: "add"; tool: ToolInput }
  | { op: "list" }
  | { op: "best"; category: string }
  | { op: "approve"; id: string; approved?: boolean };

/** AI Vault plugin (service "toolvault"). */
export function createToolVaultPlugin(opts: { vault?: ToolVault; file?: string } = {}): Plugin {
  const vault = opts.vault ?? new ToolVault(opts.file);
  return {
    manifest: { name: "toolvault", version: "0.1.0", capabilities: ["toolvault"], permissions: [], role: "executor" },
    register(ctx) {
      ctx.provide("toolvault", async (payload) => {
        const cmd = payload as ToolVaultCommand;
        if (cmd.op === "add") return vault.add(cmd.tool);
        if (cmd.op === "list") return vault.list();
        if (cmd.op === "best") return vault.best(cmd.category);
        if (cmd.op === "approve") return vault.approve(cmd.id, cmd.approved);
        throw new Error(`toolvault: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
