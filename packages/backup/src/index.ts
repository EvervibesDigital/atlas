import type { Plugin } from "@atlas/core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Backup — the safety net. Before ATLAS ever changes a codebase, it takes a
 * snapshot so a clean, pre-change state can be restored if something breaks.
 * For a git repo this is a non-destructive snapshot of the working tree
 * (via `git stash create` + a lightweight tag) — nothing about the working
 * branch is altered. Non-git folders are reported so Mat can `git init` to
 * enable snapshots.
 */
export interface Snapshot {
  method: "git" | "none";
  dir: string;
  ref?: string;
  tag?: string;
  advice?: string;
}

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", dir, ...args]);
  return stdout.trim();
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    return (await git(dir, ["rev-parse", "--is-inside-work-tree"])) === "true";
  } catch {
    return false;
  }
}

export async function snapshot(dir: string): Promise<Snapshot> {
  if (!(await isGitRepo(dir))) {
    return { method: "none", dir, advice: "not a git repo — run `git init` here to enable automatic restore points" };
  }
  // A commit capturing the current working tree WITHOUT touching the branch.
  let ref = "";
  try {
    ref = await git(dir, ["stash", "create"]);
  } catch {
    ref = "";
  }
  if (!ref) ref = await git(dir, ["rev-parse", "HEAD"]); // clean tree → HEAD is the snapshot
  const tag = `atlas-backup-${Date.now()}`;
  try {
    await git(dir, ["tag", tag, ref]);
  } catch {
    /* tagging is best-effort */
  }
  return { method: "git", dir, ref, tag };
}

/** Restore tracked files to a prior snapshot ref (recovery after a bad change). */
export async function restore(dir: string, ref: string): Promise<{ ok: boolean; detail: string }> {
  if (!(await isGitRepo(dir))) return { ok: false, detail: "not a git repo" };
  await git(dir, ["checkout", ref, "--", "."]);
  return { ok: true, detail: `restored working tree to ${ref}` };
}

export type BackupCommand = { op: "snapshot"; dir: string } | { op: "restore"; dir: string; ref: string };

/** Backup plugin (service "backup"). */
export function createBackupPlugin(): Plugin {
  return {
    manifest: { name: "backup", version: "0.1.0", capabilities: ["backup"], permissions: [], role: "executor" },
    register(ctx) {
      ctx.provide("backup", async (payload) => {
        const cmd = payload as BackupCommand;
        if (cmd.op === "snapshot") {
          const snap = await snapshot(cmd.dir);
          await ctx.emit("backup.snapshot", { dir: cmd.dir, method: snap.method, tag: snap.tag });
          return snap;
        }
        if (cmd.op === "restore") return restore(cmd.dir, cmd.ref);
        throw new Error(`backup: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
