export type LeadStatus = "new" | "approved" | "rejected" | "contacted";

export interface ScanIssue {
  category: "accessibility" | "privacy" | "security" | "seo" | "mobile";
  issue: string;
}

export interface ScanResult {
  url: string;
  overallScore: number; // 0-100, 100 = no issues found
  issues: ScanIssue[];
  /** Contact address found on the page, when one could be identified.
   * Extracted during the scan because the HTML is already in hand. */
  contactEmail?: string;
}

export interface Lead {
  id: string;
  businessName: string;
  website: string;
  phone?: string;
  email?: string;
  city: string;
  niche: string;
  status: LeadStatus;
  foundAt: string;
  scan?: ScanResult;
  dedupeKey: string;
}

/** Commands accepted by the "leadscan" service (single-handler dispatch). */
export type LeadScanCommand =
  | { op: "scan"; url: string }
  | { op: "findLeads"; niche: string; city: string }
  | { op: "list"; status?: LeadStatus }
  | { op: "approve"; id: string }
  | { op: "reject"; id: string }
  /** Renders cold outreach for a batch of `new` leads, in the shape `sender`
   * takes. Identity comes from secrets, not the request. Sends nothing. */
  | { op: "draftBatch"; ids?: string[]; startingPrice?: string }
  /** Drafts + sends unattended via sender.sendAutonomous — the daily-digest
   * path. No per-email human read step. */
  | { op: "autoOutreach"; ids?: string[]; startingPrice?: string; maxPerRun?: number }
  /** Marks a lead contacted AFTER `sender` really delivered to it. Distinct
   * from `approve`, which fires the n8n new-lead confirmation workflow. */
  | { op: "markSent"; id: string }
  /** Renders the cold-outreach email for one lead so the wording can be read
   * and approved before anything is sent. Sends nothing. */
  | {
      op: "draftOutreach";
      id: string;
      senderName: string;
      companyName: string;
      companyAddress: string;
      startingPrice?: string;
    };
