import { spawn } from "node:child_process";
import { loadEnv } from "@atlas/app";
import { createControlPanel } from "./server";

loadEnv();

/** Best-effort: pop open the default browser at the panel URL. */
function openBrowser(url: string): void {
  if (process.env.ATLAS_NO_OPEN) return;
  try {
    const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* opening the browser is a convenience, not a requirement */
  }
}

/** `pnpm ui` — start the ATLAS control panel on localhost. */
const panel = createControlPanel();
const port = Number(process.env.ATLAS_UI_PORT ?? 4317);
// Default stays loopback-only (laptop). Cloud deploys set ATLAS_HOST=0.0.0.0
// so the reverse proxy (Traefik) can reach the container.
const host = process.env.ATLAS_HOST ?? "127.0.0.1";

panel.listen(port, host).then((p) => {
  const url = `http://127.0.0.1:${p}`;
  console.log("\n🛰️  ATLAS Control Panel is running.");
  console.log(`   Open  →  ${url}`);
  console.log("   Keep this window open — ATLAS runs while it's open. Close it to stop.\n");
  openBrowser(url);
});
