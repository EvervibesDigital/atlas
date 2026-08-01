export type GigStatus = "new" | "approved" | "rejected" | "submitted" | "responded" | "won" | "completed" | "paid";

/** Where a posting came from. "web" = sanctioned search API (Tavily/Serper) —
 * the only source that runs by default. "craigslist"/"fiverr"/"guru" are
 * opt-in scrapes; see plugin.ts header for why they're not on by default. */
export type GigSource = "web" | "craigslist" | "fiverr" | "guru";

export interface Gig {
  id: string;
  source: GigSource;
  title: string;
  url: string;
  snippet: string;
  budget?: number;
  foundAt: string;
  status: GigStatus;
  dedupeKey: string;
  draftBid?: string;
  submittedAt?: string;
  paidAmount?: number;
  notes?: string;
  /** Scoped work + Claude Code handoff prompt, set by the planWork op.
   * Stored on the gig the same way draftBid is, so it travels with the gig
   * through the existing list/approve/status flow. */
  workPackage?: import("./work-package").WorkPackage;
}

export interface GigCandidate {
  source: GigSource;
  title: string;
  url: string;
  snippet: string;
  budget?: number;
}

export interface GigStats {
  new: number;
  approved: number;
  submitted: number;
  responded: number;
  won: number;
  completed: number;
  paid: number;
  rejected: number;
  totalEarned: number;
}
