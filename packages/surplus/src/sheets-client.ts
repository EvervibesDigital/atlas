import { sign } from "node:crypto";
import type { FetchLike } from "./twin-client";

// Reads Mat's own "Surplus Funds Platform v2" Leads sheet directly — the
// leads already live in HIS Google account (see types.ts header). This is a
// read-only Google Sheets client authenticated as a service account (JWT
// bearer flow), so ATLAS can turn each row into a real, individually
// approvable Morning Brief item instead of only being able to trigger the
// whole Lead Outreach Agent blind.
//
// No third-party Google SDK — the JWT-bearer OAuth flow is a handful of
// lines with Node's built-in crypto, and every other ATLAS integration in
// this repo is a plain fetch client, so this follows suit.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

function base64url(input: Buffer | string): string {
  return (Buffer.isBuffer(input) ? input : Buffer.from(input)).toString("base64url");
}

/** Exchanges a service-account key pair for a short-lived OAuth access token. */
async function getAccessToken(clientEmail: string, privateKey: string, f: FetchLike): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = { iss: clientEmail, scope: SHEETS_SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  // Private keys pasted into an env var often arrive with literal "\n" instead of real newlines.
  const pem = privateKey.includes("\\n") ? privateKey.replace(/\\n/g, "\n") : privateKey;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), pem);
  const jwt = `${signingInput}.${base64url(signature)}`;

  const r = await f(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }).toString(),
  });
  if (!r.ok) throw new Error(`google oauth token exchange -> HTTP ${r.status}`);
  const data = (await r.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("google oauth: no access_token in response");
  return data.access_token;
}

export class GoogleSheetsClient {
  constructor(
    private clientEmail: string,
    private privateKey: string,
    private f: FetchLike = fetch,
  ) {}

  /** Reads a sheet and maps rows to objects keyed by the (lowercased, trimmed) header row. */
  async getRows(spreadsheetId: string, range = "A:Z"): Promise<Array<Record<string, string>>> {
    const token = await getAccessToken(this.clientEmail, this.privateKey, this.f);
    const r = await this.f(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`sheets values.get -> HTTP ${r.status}`);
    const data = (await r.json()) as { values?: string[][] };
    const rows = data.values ?? [];
    if (rows.length < 2) return [];
    const headers = rows[0]!.map((h) => h.trim().toLowerCase());
    return rows.slice(1).map((row) => {
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => {
        obj[h] = row[i] ?? "";
      });
      return obj;
    });
  }
}
