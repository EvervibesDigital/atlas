/** Everything the publisher needs to post one Reel. */
export interface PublishInput {
  personaHandle: string;
  /** Path/URL to the rendered vertical MP4. `null` = not rendered yet. */
  videoRef: string | null;
  caption: string;
  hashtags: string[];
  width: number;
  height: number;
  durationSec: number;
}

export type PublishStatus =
  | "posted" // real post happened (only with a live publisher + login)
  | "dry-run" // validated and "would post", but intentionally did NOT post
  | "pending-approval" // waiting on Mat
  | "pending-render" // no rendered video yet
  | "rejected"; // failed validation

export interface PublishResult {
  status: PublishStatus;
  detail: string;
  approvalId?: string;
  /** The exact browser steps that WOULD post it (shown, not executed, in dry-run). */
  recipe?: BrowserStep[];
}

/** A single declarative browser step. Data only — nothing runs it yet. */
export interface BrowserStep {
  action: "goto" | "click" | "upload" | "fill" | "waitFor";
  /** CSS/text selector for click/upload/fill/waitFor. */
  selector?: string;
  /** URL for goto. */
  url?: string;
  /** Which PublishInput field supplies the value (e.g. "videoRef", "caption"). */
  valueFrom?: "videoRef" | "caption";
  note?: string;
}

export type PublishCommand = { op: "publish"; input: PublishInput } | { op: "validate"; input: PublishInput };
