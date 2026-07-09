import type { Plugin, RiskLevel } from "@atlas/core";
import type { BrowserDriver, BrowserStep } from "@atlas/browser";
import { SimulatedDriver } from "@atlas/browser";

/**
 * Action layer — the gated bridge between ATLAS deciding to DO something in the
 * real world (sign up for a site, post, install a repo, drive a browser) and it
 * actually happening.
 *
 * EVERY action is approval-gated: `request` files an approval and does nothing
 * else. Only when Mat approves does the action run — and by default it runs
 * through the SimulatedDriver, which logs what it WOULD do and touches nothing.
 * Swapping in a real (Playwright) driver + real execution is a deliberate flip,
 * exactly like the publisher. This is how a 24/7 agent gets hands without the
 * risk of it acting unsupervised.
 */
export type ActionType = "signup" | "install" | "browse" | "post" | "custom";

export interface ActionRequest {
  type: ActionType;
  title: string;
  detail?: string;
  /** A URL or "owner/repo". */
  target?: string;
  /** Browser steps to run on approval (for signup/browse/post). */
  steps?: BrowserStep[];
  /** Override the default risk tier. */
  risk?: RiskLevel;
}

export type ActionStatus = "pending-approval" | "executed" | "simulated" | "rejected" | "failed";

export interface ActionRecord {
  id: string;
  approvalId: string;
  request: ActionRequest;
  status: ActionStatus;
  result?: string;
  log?: string[];
  at: string;
}

export type ActionCommand =
  | { op: "request"; request: ActionRequest }
  | { op: "list" }
  | { op: "result"; approvalId: string };

function defaultRisk(type: ActionType): RiskLevel {
  // Creating accounts / installing code / spending are the highest tier.
  return type === "signup" || type === "install" ? 3 : 2;
}

interface Approval {
  id: string;
  status: string;
}

/**
 * Actions plugin (service "actions"). `driver` defaults to SimulatedDriver
 * (safe). `secrets` supplies credential values to browser steps by reference.
 */
export function createActionsPlugin(opts: { driver?: BrowserDriver; secrets?: Record<string, string> } = {}): Plugin {
  const driver = opts.driver ?? new SimulatedDriver();
  const real = driver.name !== "simulated";

  return {
    manifest: { name: "actions", version: "0.1.0", capabilities: ["actions"], permissions: ["call:approvals"], role: "executor" },
    register(ctx) {
      const byApproval = new Map<string, ActionRecord>();
      const history: ActionRecord[] = [];

      async function execute(record: ActionRecord): Promise<void> {
        const req = record.request;
        try {
          if (req.steps && req.steps.length) {
            const res = await driver.run(req.steps, { secrets: opts.secrets });
            record.log = res.log;
            record.status = real ? "executed" : "simulated";
            record.result = `${real ? "Ran" : "Simulated"} ${res.stepsRun} browser step(s) for "${req.title}"`;
          } else if (req.type === "install") {
            record.status = "simulated";
            record.result = `Would install ${req.target ?? "repo"} (git clone + install). Real code execution stays manual until a sandbox is enabled.`;
          } else {
            record.status = "simulated";
            record.result = `No steps supplied — recorded "${req.title}" as a plan.`;
          }
        } catch (e) {
          record.status = "failed";
          record.result = (e as Error).message;
        }
        await ctx.emit("action.executed", { id: record.id, status: record.status, title: req.title });
      }

      ctx.on("approval.granted", async (payload) => {
        const rec = byApproval.get((payload as Approval).id);
        if (rec && rec.status === "pending-approval") await execute(rec);
      });
      ctx.on("approval.rejected", async (payload) => {
        const rec = byApproval.get((payload as Approval).id);
        if (rec) rec.status = "rejected";
      });

      ctx.provide("actions", async (payload) => {
        const cmd = payload as ActionCommand;

        if (cmd.op === "request") {
          const req = cmd.request;
          const risk = req.risk ?? defaultRisk(req.type);
          const approval = (await ctx.call("approvals", {
            op: "request",
            action: `${req.type.toUpperCase()}: ${req.title}`,
            detail: req.detail ?? req.target,
            risk,
          })) as Approval;
          const record: ActionRecord = { id: `act_${approval.id.slice(0, 8)}`, approvalId: approval.id, request: req, status: "pending-approval", at: new Date().toISOString() };
          byApproval.set(approval.id, record);
          history.unshift(record);
          return record;
        }

        if (cmd.op === "list") return history.slice(0, 50);
        if (cmd.op === "result") return byApproval.get(cmd.approvalId) ?? null;
        throw new Error(`actions: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}

/** Build a generic signup recipe (browser steps) from field selectors. */
export function signupRecipe(url: string, fields: { selector: string; value?: string; valueFromCred?: string }[], submitSelector: string): BrowserStep[] {
  return [
    { action: "goto", url, note: "open signup page" },
    ...fields.map((f) => ({ action: "fill" as const, selector: f.selector, value: f.value, valueFromCred: f.valueFromCred })),
    { action: "click", selector: submitSelector, note: "submit — runs only after approval + real driver" },
  ];
}
