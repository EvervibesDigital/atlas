import { Atlas } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { createBrainPlugin } from "@atlas/brain";
import { createMemoryPlugin, type MemoryStore } from "@atlas/memory";
import { createApprovalsPlugin, ApprovalGateway } from "@atlas/approvals";
import { createExecutivePlugin } from "@atlas/executive";
import { createPersonasPlugin } from "@atlas/personas";
import { createCreativePlugin } from "@atlas/creative";
import { createPublishingPlugin, type Publisher } from "@atlas/publishing";

export interface AtlasOptions {
  memoryStore?: MemoryStore;
  memoryFile?: string;
  approvalsGateway?: ApprovalGateway;
  approvalsFile?: string;
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

  return atlas;
}
