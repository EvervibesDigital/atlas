import type { PluginManifest, GuardianVerdict } from "@atlas/core";

/**
 * Guardian — the security layer. Enforces core principle #5 ("human approval
 * overrides AI") and the two unbreakable seams from the ATLAS constitution:
 *
 *   Seam 1: a `planner` role can plan but CANNOT execute.
 *   Seam 2: an `executor` role can act but CANNOT change policy.
 *
 * On top of the seams, a fixed set of high-risk actions ALWAYS require human
 * approval, regardless of what a plugin's permissions say.
 */

/** High-risk actions that always require human approval. */
export const APPROVAL_REQUIRED: readonly string[] = [
  "file.delete",
  "file.overwrite",
  "software.install",
  "repo.install",
  "script.run",
  "code.change",
  "prod.change",
  "deploy",
  "git.push",
  "git.force",
  "money",
  "account.create",
  "purchase",
  "subscription",
  "credential.change",
  "dns.change",
  "domain",
  "email.send",
  "system.modify",
];

export class Guardian {
  private grants = new Map<string, PluginManifest>();

  /** Record a plugin's declared role + permissions. Called by the kernel on load. */
  grant(manifest: PluginManifest): void {
    this.grants.set(manifest.name, manifest);
  }

  /** Decide allow / deny / pending for a plugin attempting an action. */
  check(manifest: PluginManifest, action: string): GuardianVerdict {
    const grant = this.grants.get(manifest.name);
    if (!grant) {
      return { decision: "deny", reason: `plugin "${manifest.name}" has no grant` };
    }

    // ── Seam 1: planners cannot execute ────────────────────────────────
    if (grant.role === "planner" && this.isExecution(action)) {
      return { decision: "deny", reason: "planner role cannot execute actions" };
    }

    // ── Seam 2: executors cannot mutate policy ─────────────────────────
    if (grant.role === "executor" && this.isPolicyChange(action)) {
      return { decision: "deny", reason: "executor role cannot change policy" };
    }

    // ── High-risk actions → human approval, always ─────────────────────
    if (this.requiresApproval(action)) {
      return { decision: "pending", reason: "requires human approval" };
    }

    // ── Otherwise it must be in the plugin's declared permissions ──────
    if (this.permitted(grant, action)) {
      return { decision: "allow", reason: "permitted" };
    }
    return { decision: "deny", reason: `action "${action}" not in permissions` };
  }

  private requiresApproval(action: string): boolean {
    return APPROVAL_REQUIRED.some((a) => action === a || action.startsWith(`${a}:`) || action.startsWith(`${a}.`));
  }

  private permitted(grant: PluginManifest, action: string): boolean {
    return grant.permissions.some((p) => {
      if (p === "*") return true;
      if (p.endsWith("*")) return action.startsWith(p.slice(0, -1));
      return action === p;
    });
  }

  private isExecution(action: string): boolean {
    return action === "execute" || action.startsWith("execute.") || action.startsWith("execute:");
  }

  private isPolicyChange(action: string): boolean {
    return action === "policy" || action.startsWith("policy.") || action.startsWith("guardian.");
  }
}
