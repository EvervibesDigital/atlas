import type { PublishInput, PublishResult } from "./types";
import { INSTAGRAM_REELS_RECIPE, validateForInstagram } from "./instagram";

/** A thing that can (eventually) post a Reel. */
export interface Publisher {
  publish(input: PublishInput): Promise<PublishResult>;
}

/**
 * DryRunPublisher — the SAFE DEFAULT. It validates the Reel and returns the
 * exact browser recipe it *would* run, but posts nothing. This is how ATLAS
 * stays "ready to post" without ever posting until Mat swaps in a live
 * publisher. Flipping to real posting is a one-line change at the composition
 * root — nothing else in the pipeline changes.
 */
export class DryRunPublisher implements Publisher {
  async publish(input: PublishInput): Promise<PublishResult> {
    const check = validateForInstagram(input);
    if (!check.ok) return { status: "rejected", detail: check.problems.join("; ") };
    if (!input.videoRef) return { status: "pending-render", detail: "no rendered MP4 yet" };
    return {
      status: "dry-run",
      detail: `validated; WOULD post Reel for ${input.personaHandle} (not posted)`,
      recipe: INSTAGRAM_REELS_RECIPE,
    };
  }
}
