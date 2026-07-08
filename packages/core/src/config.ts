/**
 * Config & Secrets Vault.
 *
 * Non-secret config is freely readable. Secrets (API keys, tokens) are marked
 * as such and can ONLY be handed to a plugin through the Guardian-brokered
 * `secret()` path on the plugin context — never read directly. This is core
 * principle #12: security by design.
 */
export class ConfigVault {
  private store = new Map<string, string>();
  private secretKeys = new Set<string>();

  constructor(private env: Record<string, string | undefined> = process.env) {}

  /** Set a config value. Mark `secret: true` for anything sensitive. */
  set(key: string, value: string, opts: { secret?: boolean } = {}): void {
    this.store.set(key, value);
    if (opts.secret) this.secretKeys.add(key);
  }

  /** Read non-secret config. Falls back to the environment. */
  get(key: string): string | undefined {
    if (this.secretKeys.has(key)) return undefined; // secrets never leak via get()
    return this.store.get(key) ?? this.env[key];
  }

  isSecret(key: string): boolean {
    return this.secretKeys.has(key);
  }

  /**
   * Raw secret access. KERNEL-ONLY — plugins reach this exclusively through
   * the Guardian-checked `secret()` context method. The leading underscore
   * marks it as internal.
   */
  _getSecret(key: string): string | undefined {
    return this.store.get(key) ?? this.env[key];
  }
}
