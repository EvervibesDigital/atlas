import { buildAtlas } from "./packages/app/src/build";
import * as fs from "fs/promises";
import * as path from "path";

const kbPath = "C:\\Users\\matbr\\.gemini\\antigravity\\brain\\7c7737d3-6948-4e68-91b9-492de5f5ff33\\projects_knowledge_base.md";
const auditPath = "C:\\Users\\matbr\\.gemini\\antigravity\\brain\\7c7737d3-6948-4e68-91b9-492de5f5ff33\\references_audit_report.md";
const wtPath = "C:\\Users\\matbr\\.gemini\\antigravity\\brain\\7c7737d3-6948-4e68-91b9-492de5f5ff33\\walkthrough.md";

async function main() {
  const atlas = await buildAtlas({
    memoryFile: "./data/memory.json",
    approvalsFile: "./data/approvals.json",
    metricsFile: "./data/metrics.json",
    businessFile: "./data/businesses.json",
    toolVaultFile: "./data/toolvault.json",
    skillsFile: "./data/skills.json",
    forgeDir: "./forge",
  });

  const files = [kbPath, auditPath, wtPath];
  let totalSeeded = 0;

  for (const file of files) {
    try {
      const content = await fs.readFile(file, "utf8");
      // Split content by headings to create clean semantic units
      const sections = content.split(/\n(?=##?\s)/);
      for (const section of sections) {
        const trimmed = section.trim();
        if (trimmed.length < 50) continue;
        
        await atlas.invoke("memory", {
          op: "remember",
          input: {
            kind: "semantic",
            content: trimmed,
            metadata: { source: path.basename(file) }
          }
        });
        totalSeeded++;
        console.log(`Seeded memory from ${path.basename(file)}: "${trimmed.split('\n')[0]}..."`);
      }
    } catch (e) {
      console.error(`Error seeding file ${file}:`, e);
    }
  }

  console.log(`\nSuccessfully seeded ${totalSeeded} new knowledge chunks into ATLAS memory!`);
}

main().catch(console.error);
