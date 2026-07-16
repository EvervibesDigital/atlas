import { describe, it, expect } from "vitest";
import type { Plugin } from "@atlas/core";
import { InMemoryStore } from "@atlas/memory";
import { ApprovalGateway } from "@atlas/approvals";
import { DEFAULT_PERSONA } from "@atlas/personas";
import type { ReelSpec } from "@atlas/creative";
import type { PublishInput, PublishResult } from "@atlas/publishing";
import type { CategoryMetrics } from "@atlas/learning";
import { StubAdapter } from "@atlas/brain";
import { buildAtlas } from "../src/build";

/**
 * PHASE 2 WALKING SKELETON.
 * The whole faceless-influencer spine, offline, with NOTHING posted:
 *   persona → Brain writes script → Creative builds a render-ready Reel →
 *   Publishing validates + requests approval → Mat approves → dry-run "would
 *   post" → Memory records the lesson.
 */
describe("Instagram Reels walking skeleton", () => {
  async function run() {
    const atlas = await buildAtlas({ memoryStore: new InMemoryStore(), approvalsGateway: new ApprovalGateway(), brainAdapters: [new StubAdapter()] });
    const published: Array<{ result: PublishResult }> = [];
    atlas.events.on("reel.published", (e) => void published.push(e as { result: PublishResult }));
    return { atlas, published };
  }

  it("produces a valid Reel, gates posting on approval, then dry-runs (never posts)", async () => {
    const { atlas, published } = await run();

    let publishResult: PublishResult | undefined;
    let learned: CategoryMetrics | undefined;
    const studio: Plugin = {
      manifest: {
        name: "studio",
        version: "1",
        capabilities: [],
        permissions: ["call:creative", "call:publishing", "call:approvals", "call:memory", "call:learning"],
        role: "executor",
      },
      async register(ctx) {
        const spec = (await ctx.call("creative", {
          op: "writeReel",
          personaHandle: DEFAULT_PERSONA.handle,
          topic: "3 AI tools that save you hours",
        })) as ReelSpec;

        // Simulate the render step producing an MP4 (encode is the one remaining
        // real-world hookup; here we hand the publisher a rendered file ref).
        const input: PublishInput = {
          personaHandle: spec.personaHandle,
          videoRef: "rendered/reel-001.mp4",
          caption: spec.caption,
          hashtags: spec.hashtags,
          width: spec.width,
          height: spec.height,
          durationSec: spec.estDurationSec,
        };

        publishResult = (await ctx.call("publishing", { op: "publish", input })) as PublishResult;
        // Nothing posted yet — it's waiting for Mat.
        expect(publishResult.status).toBe("pending-approval");

        // Mat approves from his daily list.
        await ctx.call("approvals", { op: "approve", id: publishResult.approvalId! });

        // Record what happened.
        await ctx.call("memory", { op: "remember", input: { kind: "success", content: `Queued a Reel about ${spec.topic}` } });

        // The learning layer should already have auto-recorded the outcome.
        learned = (await ctx.call("learning", { op: "metrics", category: spec.personaHandle })) as CategoryMetrics;
      },
    };

    await atlas.use(studio);

    // After approval, exactly one dry-run "publish" fired — and it did NOT post.
    expect(published).toHaveLength(1);
    expect(published[0]!.result.status).toBe("dry-run");
    expect(published[0]!.result.recipe?.at(-1)?.selector).toMatch(/Share/);

    // The loop closed: ATLAS learned from the outcome.
    expect(learned?.successes).toBe(1);

    // The whole thing was audited (approval requested + granted).
    const actions = atlas.audit.entries.map((e) => e.action);
    expect(actions).toContain("call:approvals");
  });

  it("won't request approval until a video is actually rendered", async () => {
    const { atlas } = await run();

    let result: PublishResult | undefined;
    await atlas.use({
      manifest: { name: "studio2", version: "1", capabilities: [], permissions: ["call:publishing"], role: "executor" },
      async register(ctx) {
        result = (await ctx.call("publishing", {
          op: "publish",
          input: {
            personaHandle: DEFAULT_PERSONA.handle,
            videoRef: null,
            caption: "hi #ai",
            hashtags: ["ai"],
            width: 1080,
            height: 1920,
            durationSec: 20,
          },
        })) as PublishResult;
      },
    });

    expect(result?.status).toBe("pending-render");
  });
});
