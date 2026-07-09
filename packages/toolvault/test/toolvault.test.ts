import { describe, it, expect } from "vitest";
import { bestFor, ToolVault, type Tool } from "../src/index";

const tools: Tool[] = [
  { id: "1", name: "Pollinations", category: "images", quality: 4, free: true, approved: false },
  { id: "2", name: "Midjourney", category: "images", quality: 5, free: false, approved: false }, // best quality but NOT approved
  { id: "3", name: "Leonardo", category: "images", quality: 3, free: true, approved: false },
];

describe("bestFor", () => {
  it("picks the best FREE tool when the top paid one isn't approved", () => {
    expect(bestFor(tools, "images")!.name).toBe("Pollinations");
  });

  it("uses the paid tool once it's approved", () => {
    const approved = tools.map((t) => (t.id === "2" ? { ...t, approved: true } : t));
    expect(bestFor(approved, "images")!.name).toBe("Midjourney");
  });

  it("returns null when nothing usable exists in the category", () => {
    expect(bestFor([{ id: "x", name: "PaidOnly", category: "video", quality: 5, free: false, approved: false }], "video")).toBeNull();
  });
});

describe("ToolVault", () => {
  it("adds, approves, and finds the best usable tool", async () => {
    const v = new ToolVault();
    await v.add({ name: "FreeGood", category: "tts", quality: 4, free: true });
    const paid = await v.add({ name: "PaidBetter", category: "tts", quality: 5, free: false });
    expect((await v.best("tts"))!.name).toBe("FreeGood"); // paid not approved yet
    await v.approve(paid.id);
    expect((await v.best("tts"))!.name).toBe("PaidBetter");
  });
});
