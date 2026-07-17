import { randomUUID } from "node:crypto";
import { EventBus } from "./events";
import { AuditLog } from "./audit";
import { ConfigVault } from "./config";
import type { Plugin, PluginManifest } from "./plugin";

/** Short, safe stringification of a run's result for the audit trail — never the full payload (could be large/sensitive), just enough to recognize what happened at a glance. */
function summarize(value: unknown): string {
  try {
    const s = typeof value === "string" ? value : JSON.stringify(value);
    return s.length > 200 ? s.slice(0, 200) + "…" : s;
  } catch {
    return String(value);
  }
}

/** A Guardian verdict. */
export type Decision = "allow" | "deny" | "pending";

export interface GuardianVerdict {
  decision: Decision;
  reason: string;
}

/**
 * The kernel depends only on this minimal interface, not on the concrete
 * Guardian implementation. That keeps `@atlas/core` free of any dependency on
 * `@atlas/guardian` (no import cycle) and lets the Guardian be swapped.
 */
export interface GuardianLike {
  grant(manifest: PluginManifest): void;
  check(manifest: PluginManifest, action: string): GuardianVerdict;
}

/** The result a plugin gets back from attempting an action. */
export interface ActResult {
  decision: Decision;
  result?: unknown;
  reason?: string;
}

/**
 * A callable service one plugin exposes for others (e.g. the Brain Router
 * exposes "brain"). Consumers reach it via `ctx.call(service, payload)`, which
 * the Guardian gates with a `call:<service>` permission.
 */
export type ServiceHandler = (payload: unknown) => Promise<unknown> | unknown;

/**
 * The surface every plugin receives. Everything here is scoped to the plugin
 * and passes through the Guardian + Audit Log. A plugin can NEVER touch the
 * raw kernel, config secrets, or another plugin directly.
 */
export interface AtlasContext {
  readonly plugin: PluginManifest;
  /** Subscribe to an event. Returns an unsubscribe function. */
  on(event: string, handler: (payload: unknown) => void | Promise<void>): () => void;
  /** Emit an event (audited). */
  emit(event: string, payload?: unknown): Promise<void>;
  /** Read non-secret config. */
  config(key: string): string | undefined;
  /** Request a secret — brokered + audited by the Guardian. */
  secret(key: string): Promise<string | undefined>;
  /**
   * Attempt an action. The Guardian decides allow/deny/pending BEFORE `run`
   * is ever called; every attempt is audited.
   */
  act(action: string, run: () => Promise<unknown> | unknown): Promise<ActResult>;
  /**
   * Expose a callable service for other plugins. The service name MUST be one
   * of this plugin's declared `capabilities`.
   */
  provide(service: string, handler: ServiceHandler): void;
  /**
   * Call a service another plugin provides. Guardian-gated by a
   * `call:<service>` permission; audited. Rejects if denied or missing.
   */
  call(service: string, payload?: unknown): Promise<unknown>;
}

/**
 * Atlas — the kernel. Wires the event bus, audit log, config vault, guardian,
 * and plugin registry, and hands each plugin a guarded context.
 *
 * A Guardian is REQUIRED (no permissive default): security must be wired in
 * explicitly at the composition root. Safety by design.
 */
export class Atlas {
  readonly events = new EventBus();
  readonly audit: AuditLog;
  readonly config: ConfigVault;
  readonly guardian: GuardianLike;
  private plugins = new Map<string, Plugin>();
  private services = new Map<string, { owner: string; handler: ServiceHandler }>();

  constructor(deps: { guardian: GuardianLike; audit?: AuditLog; config?: ConfigVault }) {
    this.guardian = deps.guardian;
    this.audit = deps.audit ?? new AuditLog();
    this.config = deps.config ?? new ConfigVault();
  }

  /** Load a plugin: register its permissions, then let it wire itself up. */
  async use(plugin: Plugin): Promise<this> {
    const { name, version } = plugin.manifest;
    if (this.plugins.has(name)) throw new Error(`Plugin "${name}" is already loaded`);
    this.plugins.set(name, plugin);
    this.guardian.grant(plugin.manifest);
    await plugin.register(this.makeContext(plugin.manifest));
    await this.audit.record({
      actor: "kernel",
      action: `plugin.load:${name}`,
      decision: "allow",
      outcome: `v${version}`,
    });
    return this;
  }

  /** Names of loaded plugins. */
  loaded(): string[] {
    return [...this.plugins.keys()];
  }

  /**
   * OWNER-ONLY: invoke a service directly, bypassing the plugin permission
   * gate. This is the human owner console (core principle #5 — human approval
   * overrides AI: the human is the ultimate authority). Not available to
   * plugins, which must use the guarded `ctx.call`.
   *
   * Records a run: a "running" entry before the handler executes, then a
   * "done" or "failed" completion entry sharing the same `id`, so the audit
   * log doubles as a queryable run history (see `AuditLog.query`).
   */
  async invoke(service: string, payload?: unknown): Promise<unknown> {
    const svc = this.services.get(service);
    if (!svc) throw new Error(`no such service "${service}"`);
    const id = randomUUID();
    const startedAt = Date.now();
    await this.audit.record({ id, actor: "owner-console", action: `invoke:${service}`, decision: "allow", status: "running" });
    try {
      const result = await svc.handler(payload);
      await this.audit.record({
        id,
        actor: "owner-console",
        action: `invoke:${service}`,
        decision: "allow",
        status: "done",
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        outcome: summarize(result),
      });
      return result;
    } catch (err) {
      await this.audit.record({
        id,
        actor: "owner-console",
        action: `invoke:${service}`,
        decision: "allow",
        status: "failed",
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        error: String(err instanceof Error ? err.message : err),
      });
      throw err;
    }
  }

  private makeContext(manifest: PluginManifest): AtlasContext {
    return {
      plugin: manifest,

      on: (event, handler) => this.events.on(event, handler),

      emit: async (event, payload) => {
        await this.audit.record({ actor: manifest.name, action: `emit:${event}`, decision: "allow" });
        await this.events.emit(event, payload);
      },

      config: (key) => this.config.get(key),

      secret: async (key) => {
        const verdict = this.guardian.check(manifest, `secret:${key}`);
        await this.audit.record({
          actor: manifest.name,
          action: `secret:${key}`,
          decision: verdict.decision,
          outcome: verdict.reason,
        });
        return verdict.decision === "allow" ? this.config._getSecret(key) : undefined;
      },

      act: async (action, run) => {
        const verdict = this.guardian.check(manifest, action);
        if (verdict.decision !== "allow") {
          await this.audit.record({
            actor: manifest.name,
            action,
            decision: verdict.decision,
            outcome: verdict.reason,
          });
          return { decision: verdict.decision, reason: verdict.reason };
        }
        try {
          const result = await run();
          await this.audit.record({ actor: manifest.name, action, decision: "allow", status: "done", outcome: "ok" });
          return { decision: "allow", result };
        } catch (err) {
          await this.audit.record({
            actor: manifest.name,
            action,
            decision: "allow",
            status: "failed",
            error: String(err instanceof Error ? err.message : err),
          });
          throw err;
        }
      },

      provide: (service, handler) => {
        if (!manifest.capabilities.includes(service)) {
          throw new Error(`plugin "${manifest.name}" cannot provide undeclared capability "${service}"`);
        }
        if (this.services.has(service)) {
          throw new Error(`service "${service}" is already provided by "${this.services.get(service)!.owner}"`);
        }
        this.services.set(service, { owner: manifest.name, handler });
        void this.audit.record({ actor: manifest.name, action: `provide:${service}`, decision: "allow" });
      },

      call: async (service, payload) => {
        const verdict = this.guardian.check(manifest, `call:${service}`);
        if (verdict.decision !== "allow") {
          await this.audit.record({ actor: manifest.name, action: `call:${service}`, decision: verdict.decision, outcome: verdict.reason });
          throw new Error(`Guardian ${verdict.decision}: call:${service} — ${verdict.reason}`);
        }
        const svc = this.services.get(service);
        if (!svc) {
          await this.audit.record({ actor: manifest.name, action: `call:${service}`, decision: "deny", outcome: "no such service" });
          throw new Error(`no such service "${service}"`);
        }
        const id = randomUUID();
        const startedAt = Date.now();
        await this.audit.record({ id, actor: manifest.name, action: `call:${service}`, decision: "allow", status: "running" });
        try {
          const result = await svc.handler(payload);
          await this.audit.record({
            id,
            actor: manifest.name,
            action: `call:${service}`,
            decision: "allow",
            status: "done",
            endedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            outcome: summarize(result),
          });
          return result;
        } catch (err) {
          await this.audit.record({
            id,
            actor: manifest.name,
            action: `call:${service}`,
            decision: "allow",
            status: "failed",
            endedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            error: String(err instanceof Error ? err.message : err),
          });
          throw err;
        }
      },
    };
  }
}
