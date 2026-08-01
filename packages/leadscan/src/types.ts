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
  | { op: "reject"; id: string };
