import type { KdpBook } from "./types";

/**
 * Books that are ready but not yet in Mat's hands — the same "generated"
 * filter the Brief uses (see @atlas/brief's fromKdp).
 */
export function backlogCount(books: KdpBook[]): number {
  return books.filter((b) => b.status === "generated").length;
}

/**
 * Auto-generation floods the Brief with near-identical-looking journal/
 * planner titles faster than a human downloads+uploads them one at a time
 * to Amazon (KDP has no auto-publish API — this is always a manual step).
 * Pause new generation once the unreviewed backlog already meets the cap,
 * instead of piling on indefinitely every cycle.
 */
export function shouldPauseGeneration(books: KdpBook[], cap: number): boolean {
  return backlogCount(books) >= cap;
}
