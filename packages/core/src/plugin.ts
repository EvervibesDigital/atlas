import type { AtlasContext } from "./atlas";

/**
 * Plugin Contract — "every feature is a plugin" (core principle #10).
 *
 * A plugin declares what it is (manifest) and how it wires itself up
 * (register). The manifest's `role` + `permissions` are what the Guardian
 * enforces at runtime.
 */

/**
 * Security role. Enforced by the Guardian's two unbreakable seams:
 *  - a `planner` can decide/plan but CANNOT execute
 *  - an `executor` can act but CANNOT change policy
 *  - a `policy` component manages permissions but does neither
 */
export type PluginRole = "planner" | "executor" | "policy";

export interface PluginManifest {
  name: string;
  version: string;
  /** High-level capabilities provided, e.g. ["creative.video", "publish.tiktok"]. */
  capabilities: string[];
  /**
   * Actions this plugin may perform. Checked by the Guardian on every `act()`.
   * Supports exact matches ("demo.greet"), prefixes ("demo.*"), or "*" (all).
   */
  permissions: string[];
  role: PluginRole;
}

export interface Plugin {
  manifest: PluginManifest;
  /** Called once at load time with a scoped, Guardian-wrapped context. */
  register(ctx: AtlasContext): void | Promise<void>;
}
