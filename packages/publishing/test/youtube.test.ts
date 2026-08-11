import { describe, it, expect } from "vitest";
import {
  validateMetadata, isQuotaError, getAccessToken, uploadVideo,
  YT_MAX_TITLE, YT_MAX_DESCRIPTION, YT_MAX_TAGS_CHARS,
  type FetchLike, type YouTubeCredentials, type UploadMetadata,
} from "../src/youtube";

const CREDS: YouTubeCredentials = { clientId: "cid", clientSecret: "sec", refreshToken: "rt" };
const META: UploadMetadata = { title: "Stop trading your hours for dollars", description: "Follow @everspark.ai", tags: ["aitools"] };
const BYTES = new Uint8Array([1, 2, 3, 4]);

/** A fetch that fails the test if called — proves a path never hits the wire. */
const forbiddenFetch = (() => {
  throw new Error("NETWORK CALLED — this path must not reach YouTube");
}) as unknown as FetchLike;

/** Scripts the three calls an upload makes: token, init, PUT. */
function scriptedFetch(opts: {
  token?: { ok: boolean; status?: number; body?: string };
  /** `location: null` means YouTube returned no Location header at all. */
  init?: { ok: boolean; status?: number; body?: string; location?: string | null };
  put?: { ok: boolean; status?: number; body?: string };
}): { fetcher: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetcher = (async (url: string, init?: { method?: string }) => {
    const u = String(url);
    if (u.includes("oauth2.googleapis.com")) {
      calls.push("token");
      const t = opts.token ?? { ok: true };
      return { ok: t.ok, status: t.status ?? 200, text: async () => t.body ?? JSON.stringify({ access_token: "at" }) } as Response;
    }
    if (u.includes("uploadType=resumable")) {
      calls.push("init");
      const i = opts.init ?? { ok: true };
      return {
        ok: i.ok, status: i.status ?? 200,
        headers: {
          get: (h: string) => {
            if (h.toLowerCase() !== "location") return null;
            // Distinguish "not specified" from "explicitly absent".
            return i.location === undefined ? "https://upload.example/x" : i.location;
          },
        },
        text: async () => i.body ?? "{}",
      } as unknown as Response;
    }
    calls.push(`put:${init?.method}`);
    const p = opts.put ?? { ok: true };
    return { ok: p.ok, status: p.status ?? 200, text: async () => p.body ?? JSON.stringify({ id: "vid123", status: { privacyStatus: "private" } }) } as Response;
  }) as unknown as FetchLike;
  return { fetcher, calls };
}

describe("validateMetadata — checked before any bytes move", () => {
  it("accepts realistic Reel metadata", () => {
    expect(validateMetadata(META)).toEqual([]);
  });

  it("refuses an over-long title rather than truncating it", () => {
    // A title cut at 100 chars ends mid-word on a public page.
    const long = { ...META, title: "x".repeat(YT_MAX_TITLE + 1) };
    expect(validateMetadata(long).join(" ")).toMatch(new RegExp(`over YouTube's ${YT_MAX_TITLE}`));
  });

  it("requires a title", () => {
    expect(validateMetadata({ ...META, title: "   " }).join(" ")).toMatch(/title is required/);
  });

  it("rejects angle brackets, which YouTube refuses outright", () => {
    expect(validateMetadata({ ...META, title: "5 <best> tools" }).join(" ")).toMatch(/cannot contain/);
  });

  it("catches an over-long description and over-long tags", () => {
    expect(validateMetadata({ ...META, description: "x".repeat(YT_MAX_DESCRIPTION + 1) }).join(" ")).toMatch(/description is/);
    expect(validateMetadata({ ...META, tags: ["y".repeat(YT_MAX_TAGS_CHARS + 1)] }).join(" ")).toMatch(/tags total/);
  });
});

describe("isQuotaError — a 403 that is not an auth problem", () => {
  it("recognises the quota 403s", () => {
    // An upload costs 1600 of 10,000 units — about six a day. Mistaking this
    // for bad credentials sends Mat re-doing his whole OAuth setup.
    expect(isQuotaError(403, '{"error":{"errors":[{"reason":"quotaExceeded"}]}}')).toBe(true);
    expect(isQuotaError(403, "uploadLimitExceeded")).toBe(true);
  });

  it("does not claim a genuine auth 403 is a quota problem", () => {
    expect(isQuotaError(403, '{"error":"insufficientPermissions"}')).toBe(false);
    expect(isQuotaError(401, "quotaExceeded")).toBe(false);
  });
});

describe("getAccessToken", () => {
  it("exchanges the refresh token", async () => {
    const { fetcher } = scriptedFetch({});
    expect(await getAccessToken(CREDS, fetcher)).toBe("at");
  });

  it("explains invalid_grant instead of surfacing a bare 400", async () => {
    const { fetcher } = scriptedFetch({ token: { ok: false, status: 400, body: '{"error":"invalid_grant"}' } });
    await expect(getAccessToken(CREDS, fetcher)).rejects.toThrow(/revoked or expired.*consent flow/is);
  });
});

describe("uploadVideo", () => {
  it("does the resumable two-step and returns the watch url", async () => {
    const { fetcher, calls } = scriptedFetch({});
    const r = await uploadVideo({ bytes: BYTES }, META, CREDS, fetcher);
    expect(calls).toEqual(["token", "init", "put:PUT"]);
    expect(r.videoId).toBe("vid123");
    expect(r.url).toBe("https://www.youtube.com/watch?v=vid123");
  });

  it("reports the privacy YouTube ACTUALLY set, and flags a downgrade", async () => {
    // An unverified app has every upload forced private no matter what was
    // requested. A caller assuming "public" would wait for views on an
    // invisible video.
    const { fetcher } = scriptedFetch({ put: { ok: true, body: JSON.stringify({ id: "v1", status: { privacyStatus: "private" } }) } });
    const r = await uploadVideo({ bytes: BYTES }, { ...META, privacyStatus: "public" }, CREDS, fetcher);
    expect(r.privacyStatus).toBe("private");
    expect(r.privacyDowngraded).toBe(true);
  });

  it("does not flag a downgrade when the request was honoured", async () => {
    const { fetcher } = scriptedFetch({ put: { ok: true, body: JSON.stringify({ id: "v1", status: { privacyStatus: "public" } }) } });
    const r = await uploadVideo({ bytes: BYTES }, { ...META, privacyStatus: "public" }, CREDS, fetcher);
    expect(r.privacyDowngraded).toBe(false);
  });

  it("names the quota limit rather than surfacing a confusing 403", async () => {
    const { fetcher } = scriptedFetch({ init: { ok: false, status: 403, body: '{"error":{"errors":[{"reason":"quotaExceeded"}]}}' } });
    await expect(uploadVideo({ bytes: BYTES }, META, CREDS, fetcher)).rejects.toThrow(/quota.*six per day/is);
  });

  it("validates BEFORE uploading — bad metadata never touches the network", async () => {
    // A video is large; failing after the transfer wastes time and quota.
    await expect(uploadVideo({ bytes: BYTES }, { ...META, title: "" }, CREDS, forbiddenFetch)).rejects.toThrow(/title is required/);
  });

  it("refuses an empty file without calling out", async () => {
    await expect(uploadVideo({ bytes: new Uint8Array() }, META, CREDS, forbiddenFetch)).rejects.toThrow(/empty file/);
  });

  it("fails clearly when init returns no upload location", async () => {
    const { fetcher } = scriptedFetch({ init: { ok: true, location: null } });
    await expect(uploadVideo({ bytes: BYTES }, META, CREDS, fetcher)).rejects.toThrow(/no Location header/);
  });
});
