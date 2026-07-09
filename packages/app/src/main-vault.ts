import { Vault } from "@atlas/vault";
import { rm } from "node:fs/promises";

/**
 * Vault recovery helper.
 *   pnpm vault:try    — set $env:ATLAS_PW first; tests it (and safe variants)
 *                       directly against the vault file, no server involved.
 *   pnpm vault:reset  — deletes the vault so you can set a new master password.
 *                       Your API keys survive in .env and ALL memory/business/
 *                       tool/skill data is untouched — only stored platform
 *                       logins are lost.
 */
const FILE = "./data/vault.enc.json";

async function works(pw: string): Promise<boolean> {
  try {
    await new Vault(FILE).unlock(pw);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("reset")) {
    await rm(FILE, { force: true });
    console.log("\n✅ Vault reset.");
    console.log("   • Your API keys are still in .env (the Brain keeps working).");
    console.log("   • Your businesses, tools, skills and memory are untouched.");
    console.log("   • Reopen ATLAS, set a NEW master password, and re-add any platform logins.\n");
    return;
  }

  const pw = process.env.ATLAS_PW;
  if (!pw) {
    console.log('\nFirst set your candidate password, then run again:');
    console.log('   $env:ATLAS_PW = "your password here"');
    console.log("   pnpm vault:try\n");
    return;
  }

  const variants: Array<[string, string]> = [
    [pw, "exactly as typed"],
    [pw.trim(), "without surrounding spaces"],
    [pw.replace(/\s+$/, ""), "without a trailing space"],
    [pw.toLowerCase(), "all lowercase"],
  ];
  const seen = new Set<string>();
  let any = false;
  console.log("");
  for (const [candidate, label] of variants) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const ok = await works(candidate);
    if (ok) any = true;
    console.log(`${ok ? "✅ WORKS" : "❌ no   "}  — ${label}`);
  }
  if (any) {
    console.log("\nThat variant unlocks the vault — use it in the panel exactly like that.\n");
  } else {
    console.log("\nNone of those unlocked it. If you're certain of the password, tell me and we'll dig deeper.");
    console.log("Otherwise a reset is safe (keeps everything but stored logins):  pnpm vault:reset\n");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
