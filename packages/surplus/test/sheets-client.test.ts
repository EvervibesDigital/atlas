import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { GoogleSheetsClient } from "../src/sheets-client";

// A real RSA key pair so the client's actual JWT-signing code path runs;
// the fake fetch below stands in for Google's servers and doesn't need to
// verify the signature, just behave like the real token + values.get APIs.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const TEST_PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function fakeFetch(handlers: Record<string, (init?: RequestInit) => unknown>): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const handler = handlers[u.pathname];
    if (!handler) throw new Error(`no fake handler for ${u.pathname}`);
    return { ok: true, status: 200, json: async () => handler(init) } as Response;
  }) as typeof fetch;
}

describe("GoogleSheetsClient", () => {
  it("exchanges a signed JWT for an access token, then reads rows with it as a Bearer header", async () => {
    let sawTokenBody = "";
    let sawAuthHeader = "";
    const f = fakeFetch({
      "/token": (init) => {
        sawTokenBody = String(init?.body);
        return { access_token: "fake-access-token" };
      },
      "/v4/spreadsheets/sheet123/values/A:Z": (init) => {
        sawAuthHeader = (init?.headers as Record<string, string>)?.Authorization ?? "";
        return { values: [["case_number", "owner_name"], ["CASE-1", "Jane Doe"]] };
      },
    });

    const client = new GoogleSheetsClient("svc@project.iam.gserviceaccount.com", TEST_PRIVATE_KEY_PEM, f);
    const rows = await client.getRows("sheet123");

    expect(sawTokenBody).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
    expect(sawTokenBody).toMatch(/assertion=/);
    expect(sawAuthHeader).toBe("Bearer fake-access-token");
    expect(rows).toEqual([{ case_number: "CASE-1", owner_name: "Jane Doe" }]);
  });

  it("maps header row to lowercased keys and returns [] when only a header row exists", async () => {
    const f = fakeFetch({
      "/token": () => ({ access_token: "t" }),
      "/v4/spreadsheets/empty/values/A:Z": () => ({ values: [["Case Number", "Owner Name"]] }),
    });
    const rows = await new GoogleSheetsClient("svc@x.iam.gserviceaccount.com", TEST_PRIVATE_KEY_PEM, f).getRows("empty");
    expect(rows).toEqual([]);
  });

  it("handles a private key pasted with literal \\n escape sequences", async () => {
    const escaped = TEST_PRIVATE_KEY_PEM.replace(/\n/g, "\\n");
    const f = fakeFetch({
      "/token": () => ({ access_token: "t" }),
      "/v4/spreadsheets/s/values/A:Z": () => ({ values: [["case_number"], ["C1"]] }),
    });
    const rows = await new GoogleSheetsClient("svc@x.iam.gserviceaccount.com", escaped, f).getRows("s");
    expect(rows).toEqual([{ case_number: "C1" }]);
  });
});
