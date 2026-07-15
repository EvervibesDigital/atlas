import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

/** One message in a chat session. Providers/model recorded for transparency. */
export interface ChatMessage {
  role: "user" | "bot";
  text: string;
  provider?: string;
  model?: string;
  ts: number;
}

/** A saved conversation, optionally filed under a project. */
export interface ChatSession {
  id: string;
  title: string;
  project: string; // "" = no project (Inbox)
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  deleted?: boolean;
}

/** Lightweight summary for the sidebar (no message bodies). */
export interface SessionSummary {
  id: string;
  title: string;
  project: string;
  updatedAt: number;
  messageCount: number;
  deleted?: boolean;
}

/**
 * JSON-backed store for chat sessions + projects. Powers the Claude-like
 * sidebar (projects, past chats). Single-file, no DB — matches the rest of
 * ATLAS's data/ layout. Writes are immediate so nothing is lost on a crash.
 */
export class SessionStore {
  private sessions = new Map<string, ChatSession>();
  private loaded = false;

  constructor(private file: string) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.file, "utf-8");
      const arr = JSON.parse(raw) as ChatSession[];
      for (const s of arr) this.sessions.set(s.id, s);
    } catch {
      /* no file yet — start empty */
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const arr = [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    await writeFile(this.file, JSON.stringify(arr, null, 2), "utf-8");
  }

  /** All sessions as sidebar summaries, newest first. */
  async list(): Promise<SessionSummary[]> {
    await this.load();
    return [...this.sessions.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => ({ id: s.id, title: s.title, project: s.project, updatedAt: s.updatedAt, messageCount: s.messages.length, deleted: s.deleted }));
  }

  /** Distinct project names that currently have at least one chat. */
  async projects(): Promise<string[]> {
    await this.load();
    const set = new Set<string>();
    for (const s of this.sessions.values()) if (s.project) set.add(s.project);
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  async get(id: string): Promise<ChatSession | undefined> {
    await this.load();
    return this.sessions.get(id);
  }

  async create(project = "", title = "New chat"): Promise<ChatSession> {
    await this.load();
    const now = Date.now();
    const s: ChatSession = { id: randomUUID(), title, project, createdAt: now, updatedAt: now, messages: [] };
    this.sessions.set(s.id, s);
    await this.persist();
    return s;
  }

  /** Append a message; auto-title the session from the first user message. */
  async append(id: string, msg: Omit<ChatMessage, "ts">): Promise<ChatSession | undefined> {
    await this.load();
    const s = this.sessions.get(id);
    if (!s) return undefined;
    s.messages.push({ ...msg, ts: Date.now() });
    if (s.title === "New chat" && msg.role === "user") {
      s.title = msg.text.slice(0, 60).replace(/\s+/g, " ").trim() || "New chat";
    }
    s.updatedAt = Date.now();
    await this.persist();
    return s;
  }

  async rename(id: string, title: string): Promise<boolean> {
    await this.load();
    const s = this.sessions.get(id);
    if (!s) return false;
    s.title = title.slice(0, 120);
    s.updatedAt = Date.now();
    await this.persist();
    return true;
  }

  async setProject(id: string, project: string): Promise<boolean> {
    await this.load();
    const s = this.sessions.get(id);
    if (!s) return false;
    s.project = project.slice(0, 60);
    s.updatedAt = Date.now();
    await this.persist();
    return true;
  }

  async setDeleted(id: string, deleted: boolean): Promise<boolean> {
    await this.load();
    const s = this.sessions.get(id);
    if (!s) return false;
    s.deleted = deleted;
    s.updatedAt = Date.now();
    await this.persist();
    return true;
  }

  async remove(id: string, purge = false): Promise<boolean> {
    await this.load();
    const s = this.sessions.get(id);
    if (!s) return false;
    let ok = false;
    if (purge) {
      ok = this.sessions.delete(id);
    } else {
      s.deleted = true;
      s.updatedAt = Date.now();
      ok = true;
    }
    if (ok) await this.persist();
    return ok;
  }
}
