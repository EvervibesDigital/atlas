import type { Plugin } from "@atlas/core";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Skill engine — how ATLAS grows itself WITHOUT writing code. A Skill is a
 * reusable capability stored as DATA: a high-quality system prompt (plus an
 * input hint) that turns the Brain into an expert at one task. ATLAS can invent
 * new skills from a plain-English purpose, run them, and refine them over time —
 * all on free LLMs, no compilation, no Claude Code. Safe by construction: a
 * skill can only think and produce text; it cannot act on the world (that stays
 * behind the Guardian + approval).
 */
export interface Skill {
  id: string;
  name: string;
  category: string;
  description: string;
  systemPrompt: string;
  inputHint?: string;
  createdAt: string;
  timesRun: number;
}

/** Parse the Brain's skill-design output into a system prompt + input hint. */
export function parseSkillDraft(text: string, fallbackName: string): { systemPrompt: string; inputHint?: string } {
  const sys = text.match(/SYSTEM:\s*([\s\S]*?)(?:\nINPUT:|$)/i)?.[1]?.trim();
  const input = text.match(/INPUT:\s*(.+)/i)?.[1]?.trim();
  return { systemPrompt: sys && sys.length > 10 ? sys : `You are an expert at "${fallbackName}". Be practical, concrete, and concise.`, inputHint: input };
}

export class SkillRegistry {
  private items: Skill[] = [];
  private loaded = false;
  constructor(private file?: string) {}
  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file) return;
    try {
      this.items = JSON.parse(await readFile(this.file, "utf8")) as Skill[];
    } catch {
      this.items = [];
    }
  }
  private async persist(): Promise<void> {
    if (!this.file) return;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.items, null, 2), "utf8");
  }
  async add(s: Omit<Skill, "id" | "createdAt" | "timesRun">): Promise<Skill> {
    await this.load();
    const skill: Skill = { id: randomUUID(), createdAt: new Date().toISOString(), timesRun: 0, ...s };
    this.items.push(skill);
    await this.persist();
    return skill;
  }
  async list(): Promise<Skill[]> {
    await this.load();
    return [...this.items];
  }
  async get(id: string): Promise<Skill | undefined> {
    await this.load();
    return this.items.find((s) => s.id === id);
  }
  async ran(id: string): Promise<void> {
    await this.load();
    const s = this.items.find((x) => x.id === id);
    if (s) {
      s.timesRun++;
      await this.persist();
    }
  }
}

export type SkillCommand =
  | { op: "create"; name: string; category?: string; purpose: string }
  | { op: "list" }
  | { op: "run"; id: string; input: string };

/** Skills plugin (service "skills"). */
export function createSkillsPlugin(opts: { registry?: SkillRegistry; file?: string } = {}): Plugin {
  const registry = opts.registry ?? new SkillRegistry(opts.file);
  return {
    manifest: { name: "skills", version: "0.1.0", capabilities: ["skills"], permissions: ["call:brain", "call:memory"], role: "executor" },
    register(ctx) {
      ctx.provide("skills", async (payload) => {
        const cmd = payload as SkillCommand;

        if (cmd.op === "create") {
          const draft = (await ctx.call("brain", {
            system:
              "You are ATLAS's skill designer. Given a capability the agent needs, write ONE high-quality SYSTEM PROMPT that turns a language model into an expert at that task, plus a one-line hint of what input it expects. Reply EXACTLY as:\nSYSTEM: <the system prompt>\nINPUT: <one line describing the input>",
            prompt: `Capability needed: ${cmd.purpose}`,
            needs: { reasoning: 0.7, creativity: 0.5, cost: 1 },
            maxTokens: 700,
            task: "skill.design",
          })) as { text: string };
          const parsed = parseSkillDraft(draft.text, cmd.name);
          const skill = await registry.add({ name: cmd.name, category: cmd.category ?? "general", description: cmd.purpose, systemPrompt: parsed.systemPrompt, inputHint: parsed.inputHint });
          try {
            await ctx.call("memory", { op: "remember", input: { kind: "procedural", content: `New skill "${skill.name}" (${skill.category}): ${skill.description}`, metadata: { skillId: skill.id } } });
          } catch {
            /* memory optional */
          }
          await ctx.emit("skill.created", { id: skill.id, name: skill.name });
          return skill;
        }

        if (cmd.op === "list") return registry.list();

        if (cmd.op === "run") {
          const skill = await registry.get(cmd.id);
          if (!skill) throw new Error(`no skill "${cmd.id}"`);
          const out = (await ctx.call("brain", { system: skill.systemPrompt, prompt: cmd.input, needs: { reasoning: 0.6, cost: 1 }, maxTokens: 1200, task: `skill.run:${skill.name}` })) as { text: string; provider: string };
          await registry.ran(skill.id);
          return { skill: skill.name, output: out.text, provider: out.provider };
        }

        throw new Error(`skills: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
