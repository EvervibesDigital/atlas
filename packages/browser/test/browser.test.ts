import { describe, it, expect } from "vitest";
import { SimulatedDriver, createPlaywrightDriver, type BrowserStep } from "../src/index";

const steps: BrowserStep[] = [
  { action: "goto", url: "https://example.com/signup" },
  { action: "fill", selector: "#email", value: "me@example.com" },
  { action: "fill", selector: "#password", valueFromCred: "example.password" },
  { action: "click", selector: "button[type=submit]" },
];

describe("SimulatedDriver", () => {
  it("logs every step and never exposes a credential value", async () => {
    const r = await new SimulatedDriver().run(steps, { secrets: { "example.password": "hunter2" } });
    expect(r.ok).toBe(true);
    expect(r.stepsRun).toBe(4);
    const joined = r.log.join("\n");
    expect(joined).toContain("goto https://example.com/signup");
    expect(joined).toContain("•••(from vault)"); // masked, not the real password
    expect(joined).not.toContain("hunter2");
  });

  it("flags a missing credential without crashing", async () => {
    const r = await new SimulatedDriver().run([{ action: "fill", selector: "#p", valueFromCred: "nope" }]);
    expect(r.log[0]).toContain("(missing credential)");
  });
});

describe("createPlaywrightDriver", () => {
  it("fails with a clear install message when Playwright isn't installed", async () => {
    await expect(createPlaywrightDriver().run(steps)).rejects.toThrow(/Playwright is not installed/);
  });
});
