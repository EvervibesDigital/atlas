import { describe, it, expect } from "vitest";
import { Atlas, type Plugin } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { createApprovalsPlugin, ApprovalGateway, type Approval } from "@atlas/approvals";
import { extractLinks, createEmailPlugin, type MailReader, type MailSender } from "../src/index";

describe("extractLinks", () => {
  it("pulls confirmation URLs out of email text", () => {
    const links = extractLinks("Confirm here: https://site.com/verify?token=abc and ignore https://site.com/verify?token=abc");
    expect(links).toEqual(["https://site.com/verify?token=abc"]);
  });
});

describe("email plugin", () => {
  const reader: MailReader = { async recent() { return [{ from: "noreply@tool.com", subject: "Confirm your email", date: "", text: "click", links: ["https://tool.com/confirm/xyz"] }]; } };

  it("reads recent mail (safe, no approval)", async () => {
    const atlas = new Atlas({ guardian: new Guardian() });
    await atlas.use(createEmailPlugin({ reader }));
    let msgs: { messages: Array<{ links: string[] }> } | undefined;
    await atlas.use({
      manifest: { name: "c", version: "1", capabilities: [], permissions: ["call:email"], role: "executor" },
      async register(ctx) {
        msgs = (await ctx.call("email", { op: "check" })) as { messages: Array<{ links: string[] }> };
      },
    } satisfies Plugin);
    expect(msgs?.messages[0]!.links[0]).toContain("confirm");
  });

  it("gates sending behind approval, then sends", async () => {
    const sent: Array<{ to: string }> = [];
    const sender: MailSender = { async send(to) { sent.push({ to }); } };
    const atlas = new Atlas({ guardian: new Guardian() });
    await atlas.use(createApprovalsPlugin({ gateway: new ApprovalGateway() }));
    await atlas.use(createEmailPlugin({ sender }));
    await atlas.use({
      manifest: { name: "c2", version: "1", capabilities: [], permissions: ["call:email", "call:approvals"], role: "executor" },
      async register(ctx) {
        const r = (await ctx.call("email", { op: "send", to: "x@y.com", subject: "hi", body: "yo" })) as { approvalId: string; status: string };
        expect(r.status).toBe("pending-approval");
        expect(sent).toHaveLength(0); // nothing sent until approval
        await ctx.call("approvals", { op: "approve", id: r.approvalId });
      },
    });
    expect(sent).toHaveLength(1);
  });
});
