import { Atlas } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { createBrainPlugin, type ProviderAdapter } from "@atlas/brain";
import { createMemoryPlugin, HuggingFaceEmbedder, type MemoryStore, type Embedder } from "@atlas/memory";
import { createApprovalsPlugin, ApprovalGateway } from "@atlas/approvals";
import { createExecutivePlugin } from "@atlas/executive";
import { createPersonasPlugin } from "@atlas/personas";
import { createCreativePlugin } from "@atlas/creative";
import { createPublishingPlugin, type Publisher, type Renderer } from "@atlas/publishing";
import { createLearningPlugin, MetricsTracker } from "@atlas/learning";
import { createResearchPlugin } from "@atlas/research";
import { createBusinessPlugin } from "@atlas/business";
import { createGigFinderPlugin } from "@atlas/gigfinder";
import { createKdpPlugin } from "@atlas/kdp";
import { createMediaFactoryPlugin } from "@atlas/media-factory";
import { createOpportunityPlugin } from "@atlas/opportunity";
import { createTechDebtPlugin } from "@atlas/techdebt";
import { createStrategyPlugin } from "@atlas/strategy";
import { createExperimentsPlugin } from "@atlas/experiments";
import { createKnowledgePlugin } from "@atlas/knowledge";
import { createEvaluationPlugin } from "@atlas/evaluation";
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
import { createNewsletterPlugin } from "@atlas/newsletter";
import { createSetupPlugin } from "@atlas/setup";
import { createOrchestratorPlugin } from "@atlas/orchestrator";

export interface AtlasOptions {
  /** Override the brain's provider list — tests use this to force deterministic offline-stub behavior. */
  brainAdapters?: ProviderAdapter[];
  memoryStore?: MemoryStore;
  memoryFile?: string;
  approvalsGateway?: ApprovalGateway;
  approvalsFile?: string;
  metricsTracker?: MetricsTracker;
  metricsFile?: string;
  businessFile?: string;
  gigFile?: string;
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
  /**
   * Video renderer for the orchestrator's auto-render step. Defaults to the
   * real VideoRenderer (ElevenLabs/edge-tts + FFmpeg) — which depends on a
   * Windows-specific edge-tts path and network image generation, so it is
   * NOT viable on the Linux cloud deploy as shipped. Tests inject NoOpRenderer
   * to stay fast and deterministic.
   *
   * `MontageRenderer` (packages/publishing/src/montage-renderer.ts) is the
   * cross-platform replacement — Piper TTS instead of the Windows-only
   * edge-tts path, plus a post-render self-review check, both borrowed from
   * OpenMontage's approach. It needs Piper installed and its `piperBin`/
   * `piperModel` set; until then it safely behaves like NoOpRenderer. Once
   * Piper is installed, this is what the Linux cloud deploy should inject.
   */
  renderer?: Renderer;
}

/**
 * Compose the full ATLAS: kernel + Guardian + every Phase 1/2 plugin, in
 * dependency order. Returns a ready-to-drive Atlas. Runs offline with zero API
 * keys (stub Brain, JSON-file memory, dry-run publisher).
 */
export async function buildAtlas(opts: AtlasOptions = {}): Promise<Atlas> {
  const atlas = new Atlas({ guardian: new Guardian() });

  // Embedder selection. Default = offline TokenEmbedder (matches existing
  // memory.json). Real HF semantic embeddings are DOUBLE-gated: a key must be
  // present AND ATLAS_USE_HF_EMBEDDER must be truthy, because HF vectors (384-d)
  // live in a different space than token vectors and are not comparable. When
  // enabled we also switch to a dedicated store file so the two never mix.
  let embedder: Embedder | undefined;
  let memoryFile = opts.memoryFile;
  const hfKey = process.env.HUGGINGFACE_API_KEY;
  if (hfKey && process.env.ATLAS_USE_HF_EMBEDDER) {
    embedder = new HuggingFaceEmbedder(hfKey);
    if (memoryFile) memoryFile = memoryFile.replace(/\.json$/, ".hf.json");
  }

  await atlas.use(createBrainPlugin({ adapters: opts.brainAdapters }));
  await atlas.use(createEvaluationPlugin());
  await atlas.use(createMemoryPlugin({ store: opts.memoryStore, embedder, file: memoryFile }));
  await atlas.use(createApprovalsPlugin({ gateway: opts.approvalsGateway, file: opts.approvalsFile }));
  await atlas.use(createExecutivePlugin());
  await atlas.use(createPersonasPlugin());
  await atlas.use(createCreativePlugin());
  await atlas.use(createPublishingPlugin({ publisher: opts.publisher, renderer: opts.renderer }));
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
  // Find things on the internet + ATLAS's own email + newsletters + autonomous setup.
  await atlas.use(createSearchPlugin());
  await atlas.use(createEmailPlugin());
  await atlas.use(createNewsletterPlugin());
  await atlas.use(createSetupPlugin());

  // Phase 4 — departments
  await atlas.use(createResearchPlugin());
  await atlas.use(createBusinessPlugin({ businessFile: opts.businessFile }));
  await atlas.use(createGigFinderPlugin({ gigFile: opts.gigFile }));
  await atlas.use(createKdpPlugin());
  await atlas.use(createMediaFactoryPlugin());

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
