import { describe, it, expect } from "vitest";
import { checkReadiness } from "../src/status";

describe("checkReadiness", () => {
  it("reports offline stub mode with no keys", async () => {
    const r = await checkReadiness({});
    expect(r.brainMode).toBe("offline-stub");
    expect(r.publisher).toBe("dry-run");
    expect(r.pluginCount).toBeGreaterThanOrEqual(16);
  });

  it("reports live brain when a free key is present", async () => {
    const r = await checkReadiness({ GROQ_API_KEY: "gsk_test" } as NodeJS.ProcessEnv);
    expect(r.providers.groq).toBe(true);
    expect(r.brainMode).toBe("live");
    // The 'add a key' checklist item is now satisfied.
    expect(r.checklist.find((c) => c.item.includes("free LLM key"))?.done).toBe(true);
  });
});
