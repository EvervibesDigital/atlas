import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshot, restore } from "../src/index";

const run = promisify(execFile);
let dir = "";
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("backup", () => {
  it("reports non-git folders instead of failing", async () => {
    dir = await mkdtemp(join(tmpdir(), "atlas-bk-"));
    const snap = await snapshot(dir);
    expect(snap.method).toBe("none");
    expect(snap.advice).toMatch(/git init/);
  });

  it("snapshots a git repo's working tree and restores it after a bad change", async () => {
    dir = await mkdtemp(join(tmpdir(), "atlas-bk-"));
    await run("git", ["-C", dir, "init"]);
    await run("git", ["-C", dir, "config", "user.email", "t@t"]);
    await run("git", ["-C", dir, "config", "user.name", "t"]);
    await writeFile(join(dir, "app.txt"), "GOOD");
    await run("git", ["-C", dir, "add", "-A"]);
    await run("git", ["-C", dir, "commit", "-m", "init"]);

    // Make an uncommitted good change, snapshot it.
    await writeFile(join(dir, "app.txt"), "GOOD-EDIT");
    const snap = await snapshot(dir);
    expect(snap.method).toBe("git");
    expect(snap.ref).toBeTruthy();

    // A "bad AI change" breaks the file...
    await writeFile(join(dir, "app.txt"), "BROKEN");
    // ...restore brings back the snapshot state.
    await restore(dir, snap.ref!);
    expect(await readFile(join(dir, "app.txt"), "utf8")).toBe("GOOD-EDIT");
  });
});
