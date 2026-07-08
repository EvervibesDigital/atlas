import { loadEnv } from "./env";
import { buildAtlas } from "./build";

loadEnv();

/**
 * Runnable entrypoint — `pnpm start`. Boots the full ATLAS and reports what
 * loaded. Posts nothing (dry-run publisher). This proves ATLAS launches and is
 * ready to be driven.
 */
async function main(): Promise<void> {
  const atlas = await buildAtlas();
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  ATLAS online — AI That Learns, Acts & Scales ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log("Plugins loaded:", atlas.loaded().join(", "));
  console.log("Mode: OFFLINE-SAFE (stub brain, JSON memory, dry-run publisher — nothing posts).");
  console.log("Add free API keys to .env and swap in a live publisher to go live.");
}

main().catch((err) => {
  console.error("ATLAS failed to start:", err);
  process.exitCode = 1;
});
