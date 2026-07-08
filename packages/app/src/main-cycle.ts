import { runDailyCycle } from "./cycle";

/**
 * `pnpm cycle` — run one autonomous day of work and print the morning report.
 * Offline-safe by default (stub brain, dry-run publisher): drafts a Reel and
 * builds the approval list, but posts nothing.
 */
async function main(): Promise<void> {
  const report = await runDailyCycle();

  console.log("\n═══════════════ ATLAS · Daily Report ═══════════════");
  console.log(`Date:   ${report.date}`);
  console.log(`Topic:  ${report.topic}`);
  console.log(`\nBusiness brief: ${report.brief.summary}`);

  console.log("\n📌 The 3 things that matter today:");
  if (report.topPriorities.length === 0) {
    console.log("  (no performance data yet — start shipping to generate signal)");
  } else {
    report.topPriorities.forEach((p, i) => {
      const r = p as { action?: string; rationale?: string };
      console.log(`  ${i + 1}. ${r.action ?? String(p)}${r.rationale ? ` — ${r.rationale}` : ""}`);
    });
  }

  console.log(`\nDrafted Reel hook: "${report.reel.hook}"`);
  if (report.council) console.log(`Strategy Council: ${report.council.consensus} — ${report.council.recommendation}`);
  console.log(`Publish status:   ${report.publish.status} (${report.publish.detail})`);
  if (report.compliance.length > 0) {
    console.log(`\n⚠️  Compliance flags on the caption: ${report.compliance.length}`);
    for (const c of report.compliance as Array<{ detail?: string }>) console.log(`   - ${c.detail}`);
  } else {
    console.log(`Compliance:       clean ✅`);
  }
  console.log(`\nImprovement proposals: ${report.proposals.length}`);
  console.log(`⏳ Awaiting your approval: ${report.pendingApprovals.length} item(s)`);
  console.log("════════════════════════════════════════════════════");
  console.log("Nothing was posted. Review the approval list to go live.\n");
}

main().catch((err) => {
  console.error("Daily cycle failed:", err);
  process.exitCode = 1;
});
