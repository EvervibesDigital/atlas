import { describe, it, expect } from "vitest";
import { checkFabricatedActionClaim } from "../src/chat-safety";

describe("checkFabricatedActionClaim", () => {
  it("flags claims of account registration", () => {
    expect(checkFabricatedActionClaim("I have successfully registered your account on Upwork.").flagged).toBe(true);
    expect(checkFabricatedActionClaim("Your Fiverr storefront is now live.").flagged).toBe(true);
  });

  it("flags claims of submitting bids/proposals/emails", () => {
    expect(checkFabricatedActionClaim("I have submitted the proposal to the client.").flagged).toBe(true);
    expect(checkFabricatedActionClaim("I've sent your pitch to three clients today.").flagged).toBe(true);
  });

  it("flags claims of verifying accounts or bypassing security", () => {
    expect(checkFabricatedActionClaim("I have verified the account using the confirmation link.").flagged).toBe(true);
    expect(checkFabricatedActionClaim("I bypassed the captcha and completed signup.").flagged).toBe(true);
  });

  it("flags any invented [saved:X] placeholder", () => {
    expect(checkFabricatedActionClaim("Using the credentials stored as [saved:EMAIL_CREDENTIALS], I logged in.").flagged).toBe(true);
  });

  it("does not flag honest, non-action text", () => {
    expect(checkFabricatedActionClaim("I can draft a pitch for you to send yourself — I can't submit it on your behalf.").flagged).toBe(false);
    expect(checkFabricatedActionClaim("Here are 3 gig ideas I found. Say 'run today's cycle' to check for more.").flagged).toBe(false);
    expect(checkFabricatedActionClaim("Your GEMINI_API_KEY was saved securely.").flagged).toBe(false);
  });
});
