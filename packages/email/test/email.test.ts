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

describe("parseMessage", () => {
  it("extracts the real message body, not the raw MIME headers, from a realistic raw email", async () => {
    const raw = Buffer.from(
      [
        "Delivered-To: mat@example.com",
        "Received: by 2002:a05:6512:3d8b:b0:519:d1a1:1b2c with SMTP id abc123",
        "        for <mat@example.com>; Thu, 30 Jul 2026 10:00:00 -0700 (PDT)",
        "DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=example.com; s=sel1;",
        "        h=from:to:subject:date; bh=abcdef123456=; b=xyzsignature1234567890abcdefg",
        "From: Client Name <client@example.com>",
        "To: mat@example.com",
        "Subject: Congratulations! Your proposal was accepted",
        "Date: Thu, 30 Jul 2026 10:00:00 -0700",
        "Content-Type: text/plain; charset=\"UTF-8\"",
        "Content-Transfer-Encoding: 7bit",
        "",
        "Hi Mat,",
        "",
        "Congratulations! You've been hired for the python scraper project.",
        "Looking forward to working with you.",
        "",
        "Best,",
        "Client",
      ].join("\r\n"),
      "utf8",
    );

    const { parseMessage } = await import("../src/index");
    const { text, links } = await parseMessage(raw);

    expect(text).toContain("You've been hired for the python scraper project");
    expect(text).not.toContain("Delivered-To");
    expect(text).not.toContain("DKIM-Signature");
    expect(text).not.toContain("Received:");
    expect(links).toEqual([]);
  });

  it("extracts links from an HTML body when the message has no plain-text part", async () => {
    const raw = Buffer.from(
      [
        "From: Client <client@example.com>",
        "To: mat@example.com",
        "Subject: Job offer",
        "Content-Type: text/html; charset=\"UTF-8\"",
        "",
        "<p>You're hired! <a href=\"https://platform.example.com/contract/abc123\">View the contract</a></p>",
      ].join("\r\n"),
      "utf8",
    );

    const { parseMessage } = await import("../src/index");
    const { text, links } = await parseMessage(raw);

    expect(text).toContain("You're hired");
    expect(links).toEqual(["https://platform.example.com/contract/abc123"]);
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
