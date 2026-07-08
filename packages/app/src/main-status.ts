import { checkReadiness } from "./status";

/** `pnpm status` — a plain-language readiness dashboard. */
async function main(): Promise<void> {
  const r = await checkReadiness();
  const tick = (b: boolean) => (b ? "✅" : "⬜");

  console.log("\n──────────── ATLAS · Readiness ────────────");
  console.log(`Plugins active:  ${r.pluginCount}`);
  console.log(`Brain:           ${r.brainMode === "live" ? "LIVE (free models)" : "offline stub (no keys yet)"}`);
  console.log(`Publisher:       ${r.publisher} (posts nothing)`);
  console.log(`Free LLM keys:   Groq ${tick(r.providers.groq)}  Gemini ${tick(r.providers.gemini)}  OpenRouter ${tick(r.providers.openrouter)}`);
  console.log("\nTo go fully live:");
  for (const c of r.checklist) console.log(`  ${tick(c.done)} ${c.item}`);
  console.log("───────────────────────────────────────────\n");
}

main().catch((err) => {
  console.error("Status check failed:", err);
  process.exitCode = 1;
});
