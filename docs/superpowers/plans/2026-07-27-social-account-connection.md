# Social Account Connection Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the foundation that lets Mat connect his first real Instagram/Facebook account to ATLAS: encrypted token storage, the OAuth authorize-URL flow, and a callback route that completes the exchange and saves the connected account.

**Architecture:** New package `@atlas/social`. Per-account access tokens are AES-256-GCM encrypted with a key Mat provides via the vault (`SOCIAL_TOKEN_KEY`, same pattern as every other credential this session) — never a separately-managed key file, so social tokens are gated behind the exact same unlock boundary as everything else in ATLAS. Account metadata (non-secret) persists to a plain JSON file, matching every other plugin's registry pattern (`LeadRegistry`/`GigRegistry`).

**Tech Stack:** TypeScript, vitest, Node's built-in `crypto`, no new dependencies.

**Plan 2 of 3** for the AI Influencer Social Platform (see `docs/superpowers/specs/2026-07-27-social-media-platform-design.md`, and Plan 1: `docs/superpowers/plans/2026-07-27-media-factory-scaling.md`).

**Honest scope note:** Meta's exact OAuth token-exchange response shape (field names, whether the short-lived→long-lived exchange needs a separate call) isn't something I can verify without a live Meta account actually going through the flow — unlike Plan 1, where I could check every claim against real running code. This plan builds the parts I can verify with full confidence (encryption, storage, the authorize-URL format, which IS Meta's documented, stable format) and writes the token-exchange call in the well-documented standard shape, flagged for a live check the first time Mat actually connects an account — not guessed at silently. Posting itself (Graph API publish calls) and the Brief integration are Plan 3, once there's a real connected account to test against.

---

### Task 1: Package scaffold + encryption module

**Files:**
- Create: `packages/social/package.json`
- Create: `packages/social/src/crypto.ts`
- Create: `packages/social/test/crypto.test.ts`

- [ ] **Step 1: Create the package scaffold**

Create `packages/social/package.json`:

```json
{
  "name": "@atlas/social",
  "version": "0.1.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@atlas/core": "workspace:*" }
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/social/test/crypto.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { encryptToken, decryptToken } from "../src/crypto";

describe("encryptToken / decryptToken", () => {
  const key = randomBytes(32).toString("hex");

  it("round-trips a plaintext token", () => {
    const entry = encryptToken("EAABsbCS...fake-token", key);
    expect(decryptToken(entry, key)).toBe("EAABsbCS...fake-token");
  });

  it("never stores the plaintext anywhere in the encrypted entry", () => {
    const entry = encryptToken("super-secret-value", key);
    expect(JSON.stringify(entry)).not.toContain("super-secret-value");
  });

  it("fails to decrypt with the wrong key", () => {
    const entry = encryptToken("a-token", key);
    const wrongKey = randomBytes(32).toString("hex");
    expect(() => decryptToken(entry, wrongKey)).toThrow();
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx vitest run packages/social/test/crypto.test.ts`
Expected: FAIL — module `../src/crypto` doesn't exist.

- [ ] **Step 4: Implement**

Create `packages/social/src/crypto.ts`:

```typescript
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

export interface EncryptedValue {
  iv: string;
  ct: string;
  tag: string;
}

/** AES-256-GCM, same primitives as @atlas/vault — but keyed by a value the
 * caller supplies (SOCIAL_TOKEN_KEY from the vault), not a master password.
 * Plugins can't write new vault entries themselves (a deliberate boundary —
 * see @atlas/vault), so social tokens get their own encrypted-at-rest file
 * instead, gated by a key Mat sets once the same way every other credential
 * in ATLAS is set. */
export function encryptToken(plaintext: string, keyHex: string): EncryptedValue {
  const key = Buffer.from(keyHex, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { iv: iv.toString("hex"), ct: ct.toString("hex"), tag: cipher.getAuthTag().toString("hex") };
}

export function decryptToken(entry: EncryptedValue, keyHex: string): string {
  const key = Buffer.from(keyHex, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(entry.iv, "hex"));
  decipher.setAuthTag(Buffer.from(entry.tag, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(entry.ct, "hex")), decipher.final()]).toString("utf8");
}
```

- [ ] **Step 5: Confirm it passes**

Run: `npx vitest run packages/social/test/crypto.test.ts`
Expected: 3 tests passing.

- [ ] **Step 6: Install so the new workspace package is linked**

Run: `pnpm install`

- [ ] **Step 7: Commit**

```bash
git add packages/social/package.json packages/social/src/crypto.ts packages/social/test/crypto.test.ts
git commit -m "Add @atlas/social package scaffold and token encryption module"
```

---

### Task 2: Account store

**Files:**
- Create: `packages/social/src/store.ts`
- Create: `packages/social/test/store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/social/test/store.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { addAccount, findAccount, daysUntilExpiry, type SocialAccount } from "../src/store";

function account(id: string, obtainedAt: string): SocialAccount {
  return {
    id,
    platform: "instagram",
    personaLabel: "Aria Vance",
    pageId: "page123",
    igBusinessAccountId: "ig456",
    accessTokenEnc: { iv: "i", ct: "c", tag: "t" },
    tokenObtainedAt: obtainedAt,
    connectedAt: obtainedAt,
    status: "connected",
  };
}

describe("addAccount / findAccount", () => {
  it("adds a new account to the list", () => {
    const accounts = addAccount([], account("a1", new Date().toISOString()));
    expect(accounts).toHaveLength(1);
    expect(findAccount(accounts, "a1")?.personaLabel).toBe("Aria Vance");
  });

  it("findAccount returns undefined for an unknown id", () => {
    expect(findAccount([], "missing")).toBeUndefined();
  });
});

describe("daysUntilExpiry", () => {
  it("returns close to 60 for a token obtained just now (60-day validity)", () => {
    const days = daysUntilExpiry(new Date().toISOString());
    expect(days).toBeGreaterThanOrEqual(59);
    expect(days).toBeLessThanOrEqual(60);
  });

  it("returns a negative number for an already-expired token", () => {
    const obtained = new Date(Date.now() - 70 * 24 * 3600_000).toISOString();
    expect(daysUntilExpiry(obtained)).toBeLessThan(0);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run packages/social/test/store.test.ts`
Expected: FAIL — module `../src/store` doesn't exist.

- [ ] **Step 3: Implement**

Create `packages/social/src/store.ts`:

```typescript
import type { EncryptedValue } from "./crypto";

export interface SocialAccount {
  id: string;
  platform: "instagram" | "facebook";
  personaLabel: string;
  pageId: string;
  igBusinessAccountId?: string;
  accessTokenEnc: EncryptedValue;
  tokenObtainedAt: string;
  connectedAt: string;
  status: "connected" | "token_expired" | "error";
}

export function addAccount(accounts: SocialAccount[], account: SocialAccount): SocialAccount[] {
  return [...accounts, account];
}

export function findAccount(accounts: SocialAccount[], id: string): SocialAccount | undefined {
  return accounts.find((a) => a.id === id);
}

/** Meta long-lived Page tokens are valid ~60 days. Used to warn before one
 * silently expires (feeds the urgent-alert email already shipped). */
export function daysUntilExpiry(tokenObtainedAt: string, validityDays = 60): number {
  const obtained = new Date(tokenObtainedAt).getTime();
  const expiresAt = obtained + validityDays * 24 * 3600_000;
  return Math.floor((expiresAt - Date.now()) / (24 * 3600_000));
}
```

- [ ] **Step 4: Confirm it passes**

Run: `npx vitest run packages/social/test/store.test.ts`
Expected: 4 tests passing.

- [ ] **Step 5: Commit**

```bash
git add packages/social/src/store.ts packages/social/test/store.test.ts
git commit -m "Add SocialAccount store with token-expiry tracking"
```

---

### Task 3: OAuth authorize-URL builder

**Files:**
- Create: `packages/social/src/oauth.ts`
- Create: `packages/social/test/oauth.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/social/test/oauth.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildConnectUrl } from "../src/oauth";

describe("buildConnectUrl", () => {
  it("builds a Facebook OAuth dialog URL with the app id, redirect, and state", () => {
    const url = buildConnectUrl("123456789", "https://atlas.evervibesdigital.com/api/social/oauth/callback", "abc-state-token");
    expect(url).toContain("https://www.facebook.com/v21.0/dialog/oauth?");
    expect(url).toContain("client_id=123456789");
    expect(url).toContain(encodeURIComponent("https://atlas.evervibesdigital.com/api/social/oauth/callback"));
    expect(url).toContain("state=abc-state-token");
  });

  it("requests every scope posting and DM/comment reading needs", () => {
    const url = buildConnectUrl("id", "https://x/cb", "s");
    for (const scope of ["pages_show_list", "pages_manage_posts", "pages_read_engagement", "pages_messaging", "instagram_basic", "instagram_content_publish", "instagram_manage_comments"]) {
      expect(url).toContain(scope);
    }
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run packages/social/test/oauth.test.ts`
Expected: FAIL — module `../src/oauth` doesn't exist.

- [ ] **Step 3: Implement**

Create `packages/social/src/oauth.ts`:

```typescript
/** Meta's stable, documented OAuth dialog format — this part doesn't drift
 * the way response payload shapes can. Scopes match the spec's connection
 * flow: posting + reading/replying to comments and DMs. */
const SCOPES = [
  "pages_show_list",
  "pages_manage_posts",
  "pages_read_engagement",
  "pages_messaging",
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_comments",
];

export function buildConnectUrl(appId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    state,
    scope: SCOPES.join(","),
    response_type: "code",
  });
  return `https://www.facebook.com/v21.0/dialog/oauth?${params.toString()}`;
}
```

- [ ] **Step 4: Confirm it passes**

Run: `npx vitest run packages/social/test/oauth.test.ts`
Expected: 2 tests passing.

- [ ] **Step 5: Commit**

```bash
git add packages/social/src/oauth.ts packages/social/test/oauth.test.ts
git commit -m "Add Meta OAuth authorize-URL builder"
```

---

### Task 4: Token exchange (flagged for live verification)

**Files:**
- Create: `packages/social/src/token-exchange.ts`
- Create: `packages/social/test/token-exchange.test.ts`

**Honest flag:** this call's exact response field names (`access_token`, `expires_in`) match Meta's long-documented standard OAuth token response shape, but this has NOT been verified against a live call — there is no Meta test account to check it against yet. The first time Mat actually connects an account, watch this call specifically; if the response shape differs, it's a one-function fix in `token-exchange.ts`, not a mystery.

- [ ] **Step 1: Write the failing test**

Create `packages/social/test/token-exchange.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { exchangeCodeForToken } from "../src/token-exchange";

describe("exchangeCodeForToken", () => {
  it("posts the code + app credentials and returns the access token", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "EAAB...token", token_type: "bearer", expires_in: 5184000 }),
    });

    const result = await exchangeCodeForToken("the-code", "app-id", "app-secret", "https://x/cb", fetcher);

    expect(result).toEqual({ accessToken: "EAAB...token", expiresIn: 5184000 });
    const calledUrl = fetcher.mock.calls[0][0] as string;
    expect(calledUrl).toContain("client_id=app-id");
    expect(calledUrl).toContain("client_secret=app-secret");
    expect(calledUrl).toContain("code=the-code");
  });

  it("throws with the response body when the exchange fails", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: "Invalid verification code format." } }),
    });

    await expect(exchangeCodeForToken("bad-code", "id", "secret", "https://x/cb", fetcher)).rejects.toThrow(/400/);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run packages/social/test/token-exchange.test.ts`
Expected: FAIL — module `../src/token-exchange` doesn't exist.

- [ ] **Step 3: Implement**

Create `packages/social/src/token-exchange.ts`:

```typescript
export interface FetchLike {
  (url: string, init?: unknown): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
}

export interface TokenExchangeResult {
  accessToken: string;
  expiresIn?: number;
}

/** Standard OAuth code-for-token exchange against Meta's Graph API.
 * See Task 4's header note: verify this against a real response the first
 * time an account actually connects. */
export async function exchangeCodeForToken(
  code: string,
  appId: string,
  appSecret: string,
  redirectUri: string,
  fetcher: FetchLike,
): Promise<TokenExchangeResult> {
  const params = new URLSearchParams({ client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code });
  const r = await fetcher(`https://graph.facebook.com/v21.0/oauth/access_token?${params.toString()}`);
  const data = (await r.json()) as { access_token?: string; expires_in?: number; error?: { message?: string } };
  if (!r.ok) throw new Error(`token exchange failed: HTTP ${r.status} ${data.error?.message ?? JSON.stringify(data).slice(0, 200)}`);
  if (!data.access_token) throw new Error(`token exchange returned no access_token: ${JSON.stringify(data).slice(0, 200)}`);
  return { accessToken: data.access_token, expiresIn: data.expires_in };
}
```

- [ ] **Step 4: Confirm it passes**

Run: `npx vitest run packages/social/test/token-exchange.test.ts`
Expected: 2 tests passing.

- [ ] **Step 5: Commit**

```bash
git add packages/social/src/token-exchange.ts packages/social/test/token-exchange.test.ts
git commit -m "Add Meta OAuth token exchange (flagged for live verification on first real connect)"
```

---

### Task 5: The `social` plugin + OAuth callback route

**Files:**
- Create: `packages/social/src/plugin.ts`
- Create: `packages/social/src/index.ts`
- Create: `packages/social/test/plugin.test.ts`
- Modify: `packages/server/src/server.ts` (new `/api/social/oauth/callback` route)
- Modify: `packages/app/src/build.ts` (register the new plugin)

- [ ] **Step 1: Write the failing test**

Create `packages/social/test/plugin.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { Atlas, ConfigVault, type GuardianLike } from "@atlas/core";
import { createSocialPlugin } from "../src/plugin";

function permissiveGuardian(): GuardianLike {
  return { grant: () => {}, check: () => ({ decision: "allow", reason: "test" }) };
}

describe("social plugin — getConnectUrl", () => {
  it("returns a real Meta OAuth URL built from META_APP_ID and a generated state", async () => {
    const atlas = new Atlas({ guardian: permissiveGuardian(), config: new ConfigVault({ META_APP_ID: "app-123" }) });
    await atlas.use(createSocialPlugin({ redirectUri: "https://atlas.evervibesdigital.com/api/social/oauth/callback" }));

    const result = (await atlas.invoke("social", { op: "getConnectUrl" })) as { url: string };
    expect(result.url).toContain("client_id=app-123");
    expect(result.url).toContain("state=");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run packages/social/test/plugin.test.ts`
Expected: FAIL — module `../src/plugin` doesn't exist.

- [ ] **Step 3: Implement the plugin**

Create `packages/social/src/plugin.ts`:

```typescript
import type { Plugin } from "@atlas/core";
import { randomUUID } from "node:crypto";
import { buildConnectUrl } from "./oauth";

export type SocialCommand = { op: "getConnectUrl" };

export function createSocialPlugin(opts: { redirectUri: string }): Plugin {
  return {
    manifest: {
      name: "social",
      version: "0.1.0",
      capabilities: ["social"],
      permissions: ["secret:META_APP_ID", "secret:META_APP_SECRET", "secret:SOCIAL_TOKEN_KEY"],
      role: "executor",
    },
    register(ctx) {
      ctx.provide("social", async (payload) => {
        const cmd = payload as SocialCommand;
        if (cmd.op === "getConnectUrl") {
          const appId = await ctx.secret("META_APP_ID");
          if (!appId) throw new Error("social: META_APP_ID not set — add it in API Keys first");
          const state = randomUUID();
          return { url: buildConnectUrl(appId, opts.redirectUri, state), state };
        }
        throw new Error(`social: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
```

Create `packages/social/src/index.ts`:

```typescript
export * from "./crypto";
export * from "./store";
export * from "./oauth";
export * from "./token-exchange";
export * from "./plugin";
```

- [ ] **Step 4: Confirm the test passes**

Run: `npx vitest run packages/social/test/plugin.test.ts`
Expected: 1 test passing.

- [ ] **Step 5: Register the plugin in buildAtlas**

In `packages/app/src/build.ts`, add the import:

```typescript
import { createSocialPlugin } from "@atlas/social";
```

Add `@atlas/social` to `packages/app/package.json`'s dependencies (`"@atlas/social": "workspace:*"`).

Find where other business plugins are registered (`grep -n 'atlas.use(create' packages/app/src/build.ts`) and add, near the other similar registrations:

```typescript
  await atlas.use(createSocialPlugin({ redirectUri: `${process.env.ATLAS_PUBLIC_URL ?? "https://atlas.evervibesdigital.com"}/api/social/oauth/callback` }));
```

- [ ] **Step 6: Add the OAuth callback route to server.ts**

In `packages/server/src/server.ts`, find the route dispatch section (`grep -n 'method === "GET" && path === "/api/health"' packages/server/src/server.ts` to locate the right area) and add a new route near the other `/api/*` GET routes:

```typescript
    if (method === "GET" && path === "/api/social/oauth/callback") {
      const code = url.searchParams.get("code");
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h2>Connection failed</h2><p>No authorization code received.</p>");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<h2>Almost done</h2><p>Authorization received. Tell ATLAS you're ready and it'll finish connecting this account.</p><p style="color:#888;font-size:12px">code: ${code.slice(0, 8)}...</p>`);
      return;
    }
```

This intentionally stops short of completing the token exchange automatically — per this task's honest scope note, the exchange call needs to be watched live the first time it actually runs, not fired unattended on an untested code path handling a real OAuth code. Task 6 completes this once Task 4's exchange call has been verified against a real response.

- [ ] **Step 7: Typecheck and run the full suite**

Run: `pnpm install && npx tsc --noEmit -p tsconfig.json && npx vitest run`
Expected: clean typecheck, all tests passing.

- [ ] **Step 8: Commit**

```bash
git add packages/social/src/plugin.ts packages/social/src/index.ts packages/social/test/plugin.test.ts packages/app/src/build.ts packages/app/package.json packages/server/src/server.ts
git commit -m "Add social plugin's getConnectUrl op and the OAuth callback route"
```

---

### Task 6: Deploy and hand off the real connection step to Mat

**Files:** none (deploy + documentation-only task)

- [ ] **Step 1: Push and deploy**

```bash
git push origin main
scp -i ~/.ssh/atlas_deploy -r packages/social root@72.62.168.207:/opt/atlas/app/packages/
scp -i ~/.ssh/atlas_deploy packages/app/src/build.ts packages/app/package.json root@72.62.168.207:/opt/atlas/app/packages/app/
scp -i ~/.ssh/atlas_deploy packages/server/src/server.ts root@72.62.168.207:/opt/atlas/app/packages/server/src/
scp -i ~/.ssh/atlas_deploy pnpm-lock.yaml root@72.62.168.207:/opt/atlas/app/
ssh -i ~/.ssh/atlas_deploy root@72.62.168.207 "docker restart atlas && sleep 8 && curl -s -o /dev/null -w '%{http_code}\n' localhost:4317/api/health"
```

Expected: `200`.

- [ ] **Step 2: Give Mat the real next step**

Report back with exactly this handoff (this is real, human-only work — not something to automate around):

1. Generate a random encryption key: run `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and paste the output as `SOCIAL_TOKEN_KEY` in ATLAS's API Keys tab (same as every other credential this session).
2. Add the Instagram/Facebook account as a Tester on the Meta Developer app (per the earlier walkthrough).
3. Ask ATLAS for the connect link — `social.getConnectUrl` returns a real, working Meta authorization URL once `META_APP_ID` (already set) resolves.
4. Open it, log in, grant access — Meta will redirect back and show "Almost done."
5. At that point, watch the token exchange live together (Task 4's flagged verification step) rather than trust it blind, then finish wiring the account into the store (Plan 3, once posting is built and there's a real token to post with).

---

## Next

Plan 3 covers actual posting (Graph API publish calls) and the Brief integration — both need a real connected account (from this plan) to test against, which won't exist until Mat completes the handoff above.
