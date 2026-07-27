import { describe, it, expect } from "vitest";
import type { ContentItem } from "../src/db";

describe("ContentItem type", () => {
  it("includes created_at, since the underlying SQL already returns it", () => {
    // Compile-time check: this assignment must type-check. If created_at
    // isn't on the interface, TypeScript rejects this file.
    const item: ContentItem = {
      creator_id: "c1",
      platform: "instagram",
      status: "planned",
      title: "t",
      created_at: "2026-07-27T00:00:00.000Z",
    };
    expect(item.created_at).toBe("2026-07-27T00:00:00.000Z");
  });
});
