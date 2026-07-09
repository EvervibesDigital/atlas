import { loadEnv } from "./env";
import { buildAtlas } from "./build";
import { seedKnowledge } from "./seed";

/**
 * `pnpm seed` — load deep knowledge of Mat's businesses + tool stack into
 * ATLAS's real stores (business registry, AI Vault, memory). Idempotent.
 */
async function main(): Promise<void> {
  loadEnv();
  const atlas = await buildAtlas({
    memoryFile: "./data/memory.json",
    approvalsFile: "./data/approvals.json",
    metricsFile: "./data/metrics.json",
    businessFile: "./data/businesses.json",
    toolVaultFile: "./data/toolvault.json",
  });
  const r = await seedKnowledge(atlas);
  console.log(`\n🌱 ATLAS knowledge seeded:`);
  console.log(`   Businesses added: ${r.businesses}`);
  console.log(`   Tools added to the AI Vault: ${r.tools}`);
  console.log(`   Memory notes written: ${r.notes}`);
  console.log(`\nAsk ATLAS in Chat: "What do you know about my wholesale business?"\n`);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exitCode = 1;
});
