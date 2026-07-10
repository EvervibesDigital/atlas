import { Atlas } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { createBrainPlugin } from "@atlas/brain";
import { createMemoryPlugin, type MemoryStore } from "@atlas/memory";
import { createApprovalsPlugin, ApprovalGateway } from "@atlas/approvals";
import { createExecutivePlugin } from "@atlas/executive";
import { createPersonasPlugin } from "@atlas/personas";
import { createCreativePlugin } from "@atlas/creative";
import { createPublishingPlugin, type Publisher } from "@atlas/publishing";
import { createLearningPlugin, MetricsTracker } from "@atlas/learning";
import { createResearchPlugin } from "@atlas/research";
import { createBusinessPlugin } from "@atlas/business";
import { createOpportunityPlugin } from "@atlas/opportunity";
import { createTechDebtPlugin } from "@atlas/techdebt";
import { createStrategyPlugin } from "@atlas/strategy";
import { createExperimentsPlugin } from "@atlas/experiments";
import { createKnowledgePlugin } from "@atlas/knowledge";
import { createCfoPlugin } from "@atlas/cfo";
import { createAutomationPlugin } from "@atlas/automation";
import { createSimulationPlugin } from "@atlas/simulation";
import { createAnalyticsPlugin } from "@atlas/analytics";
import { createCompliancePlugin } from "@atlas/compliance";
import { createNegotiationPlugin } from "@atlas/negotiation";
import { createDetectivePlugin } from "@atlas/detective";
import { createEngineeringPlugin } from "@atlas/engineering";
import { createWebPlugin } from "@atlas/web";
import { createActionsPlugin } from "@atlas/actions";
import { createCodebasePlugin } from "@atlas/codebase";
import { createToolVaultPlugin } from "@atlas/toolvault";
import { createBackupPlugin } from "@atlas/backup";
import { createConnectorsPlugin } from "@atlas/connectors";
import { createInboxPlugin } from "@atlas/inbox";
import { createSkillsPlugin } from "@atlas/skills";
import { createForgePlugin, loadActivePlugins } from "@atlas/forge";
import { createCuriosityPlugin, createRedTeamPlugin, createLegacyPlugin, createArchaeologistPlugin, createJanitorPlugin } from "@atlas/advisors";
import { createSearchPlugin } from "@atlas/search";
import { createEmailPlugin } from "@atlas/email";
import { createOrchestratorPlugin } from "@atlas/orchestrator";

export interface AtlasOptions {
  memoryStore?: MemoryStore;
  memoryFile?: string;
  approvalsGateway?: ApprovalGateway;
  approvalsFile?: string;
  metricsTracker?: MetricsTracker;
  metricsFile?: string;
  businessFile?: string;
  toolVaultFile?: string;
  skillsFile?: string;
  /** Directory ATLAS forges new plugins into (default ./forge). */
  forgeDir?: string;
  /**
   * Publisher for the Publishing department. Defaults to a dry-run publisher
   * (never posts). Swap in a live browser publisher — with Mat's login — to go
   * live. This is the ONLY change needed to start actually posting.
   */
  publisher?: Publisher;
}

/**
 * Compose the full ATLAS: kernel + Guardian + every Phase 1/2 plugin, in
 * dependency order. Returns a ready-to-drive Atlas. Runs offline with zero API
 * keys (stub Brain, JSON-file memory, dry-run publisher).
 */
export async function buildAtlas(opts: AtlasOptions = {}): Promise<Atlas> {
  const atlas = new Atlas({ guardian: new Guardian() });

  await atlas.use(createBrainPlugin());
  await atlas.use(createMemoryPlugin({ store: opts.memoryStore, file: opts.memoryFile }));
  await atlas.use(createApprovalsPlugin({ gateway: opts.approvalsGateway, file: opts.approvalsFile }));
  await atlas.use(createExecutivePlugin());
  await atlas.use(createPersonasPlugin());
  await atlas.use(createCreativePlugin());
  await atlas.use(createPublishingPlugin({ publisher: opts.publisher }));
  await atlas.use(createLearningPlugin({ metrics: opts.metricsTracker, metricsFile: opts.metricsFile }));

  // Web reader (loaded before Business so it can research business sites).
  await atlas.use(createWebPlugin());
  // Action layer — real-world actions, approval-gated, simulated by default.
  await atlas.use(createActionsPlugin());
  // Learning & safety: codebase reader, AI tool vault, backup/restore.
  await atlas.use(createCodebasePlugin());
  await atlas.use(createToolVaultPlugin({ file: opts.toolVaultFile }));
  await atlas.use(createBackupPlugin());
  // Cloud connectors (read-only) + the from-the-road GitHub inbox.
  await atlas.use(createConnectorsPlugin());
  await atlas.use(createInboxPlugin());
  // Self-growth: skills (new capabilities as data) + forge (new plugin code).
  await atlas.use(createSkillsPlugin({ file: opts.skillsFile }));
  await atlas.use(createForgePlugin({ forgeDir: opts.forgeDir }));
  // Advisor agents (deduped from the wishlist).
  await atlas.use(createCuriosityPlugin());
  await atlas.use(createRedTeamPlugin());
  await atlas.use(createLegacyPlugin());
  await atlas.use(createArchaeologistPlugin());
  await atlas.use(createJanitorPlugin());
  // Find things on the internet + ATLAS's own email.
  await atlas.use(createSearchPlugin());
  await atlas.use(createEmailPlugin());

  // Phase 4 — departments
  await atlas.use(createResearchPlugin());
  await atlas.use(createBusinessPlugin({ businessFile: opts.businessFile }));

  // Phase 5 — advanced systems
  await atlas.use(createOpportunityPlugin());
  await atlas.use(createTechDebtPlugin());
  await atlas.use(createStrategyPlugin());
  await atlas.use(createExperimentsPlugin());
  await atlas.use(createKnowledgePlugin());
  await atlas.use(createCfoPlugin());
  await atlas.use(createAutomationPlugin());
  await atlas.use(createSimulationPlugin());
  await atlas.use(createAnalyticsPlugin());
  await atlas.use(createCompliancePlugin());
  await atlas.use(createNegotiationPlugin());
  await atlas.use(createDetectivePlugin());
  await atlas.use(createEngineeringPlugin());

  // The autonomous loop — conducts every department above.
  await atlas.use(createOrchestratorPlugin());

  // Auto-load any capabilities ATLAS has forged and Mat has approved.
  await loadActivePlugins(atlas, `${opts.forgeDir ?? "./forge"}/active`);

  return atlas;
}
