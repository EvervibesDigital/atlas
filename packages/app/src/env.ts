/**
 * Load the local git-ignored .env into process.env (if it exists) so automated
 * runs — the nightly task, `pnpm cycle`, `pnpm status` — can use real provider
 * keys without the vault's master password. Uses Node's built-in loader; a
 * missing .env is fine (offline stub mode).
 */
export function loadEnv(file = ".env"): void {
  try {
    (process as unknown as { loadEnvFile?: (f: string) => void }).loadEnvFile?.(file);
  } catch {
    /* no .env yet — offline mode */
  }
}
