import { createControlPanel } from "./server";

/** `pnpm ui` — start the ATLAS control panel on localhost. */
const panel = createControlPanel();
const port = Number(process.env.ATLAS_UI_PORT ?? 4317);

panel.listen(port).then((p) => {
  console.log("\n🛰️  ATLAS Control Panel is running.");
  console.log(`   Open  →  http://127.0.0.1:${p}`);
  console.log("   Localhost only. Your keys & logins are encrypted with your master password.\n");
});
