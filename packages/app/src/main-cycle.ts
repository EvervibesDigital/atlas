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
  console.log(`\nDrafted Reel hook: "${report.reel.hook}"`);
  if (report.council) console.log(`Strategy Council: ${report.council.consensus} — ${report.council.recommendation}`);
  console.log(`Publish status:   ${report.publish.status} (${report.publish.detail})`);
  console.log(`\nImprovement proposals: ${report.proposals.length}`);
  console.log(`⏳ Awaiting your approval: ${report.pendingApprovals.length} item(s)`);
  console.log("════════════════════════════════════════════════════");
  console.log("Nothing was posted. Review the approval list to go live.\n");
}

main().catch((err) => {
  console.error("Daily cycle failed:", err);
  process.exitCode = 1;
});
