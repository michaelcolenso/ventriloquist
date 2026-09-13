import { describe, expect, it } from "vitest";
import { createServer } from "../src/server";
import type { PoolHealth, SignOutcome, Signer } from "../src/pagePool";
import { mockCreativeCenterResponse, mockTikTokResponse } from "../src/mock";

function fakeSigner(outcome?: SignOutcome | Error): Signer {
  return {
    async sign(): Promise<SignOutcome> {
      if (outcome instanceof Error) throw outcome;
      return outcome ?? { mode: "signed", url: "https://www.tiktok.com/api/x?X-Bogus=1", headers: {}, expiresAt: null, strategy: "test" };
    },
    async health(): Promise<PoolHealth> {
      return { ok: true, poolSize: 2, ready: 2, detail: null };
    },
  };
}

describe("signer gateway routes", () => {
  it("reports pool health", async () => {
    const app = createServer({ signer: fakeSigner(), token: "secret", mock: false, logger: false });
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, pool_size: 2, ready: 2, mode: "browser" });
    await app.close();
  });

  it("requires the shared bearer token on /sign", async () => {
    const app = createServer({ signer: fakeSigner(), token: "secret", mock: false, logger: false });
    const unauthorized = await app.inject({
      method: "POST",
      url: "/sign",
      payload: { url: "https://www.tiktok.com/api/challenge/detail/?challengeName=x" },
    });
    expect(unauthorized.statusCode).toBe(401);

    const ok = await app.inject({
      method: "POST",
      url: "/sign",
      headers: { authorization: "Bearer secret" },
      payload: { url: "https://www.tiktok.com/api/challenge/detail/?challengeName=x" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ mode: "signed", signed_url: expect.stringContaining("X-Bogus") });
    await app.close();
  });

  it("refuses to sign non-TikTok hosts", async () => {
    const app = createServer({ signer: fakeSigner(), token: "", mock: false, logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/sign",
      payload: { url: "https://example.com/steal" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("host not allowed");
    await app.close();
  });

  it("surfaces pool failures as 502", async () => {
    const app = createServer({
      signer: fakeSigner(new Error("pool exhausted")),
      token: "",
      mock: false,
      logger: false,
    });
    const response = await app.inject({
      method: "POST",
      url: "/sign",
      payload: { url: "https://www.tiktok.com/api/user/detail/?uniqueId=x" },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().detail).toContain("pool exhausted");
    await app.close();
  });

  it("serves fixtures in mock mode and hides them otherwise", async () => {
    const mockApp = createServer({ signer: fakeSigner(), token: "", mock: true, logger: false });
    const signed = await mockApp.inject({
      method: "POST",
      url: "/sign",
      payload: { url: "https://www.tiktok.com/api/challenge/detail/?challengeName=babynames" },
    });
    expect(signed.statusCode).toBe(200);
    const body = signed.json();
    expect(body.mode).toBe("in_page");
    expect(JSON.parse(body.body).challengeInfo.challenge.title).toBe("babynames");

    const creative = await mockApp.inject({
      method: "GET",
      url: "/mock/creative_center/hashtag/list?limit=3&country_code=US",
    });
    expect(creative.statusCode).toBe(200);
    expect(creative.json().data.list).toHaveLength(3);
    await mockApp.close();

    const realApp = createServer({ signer: fakeSigner(), token: "", mock: false, logger: false });
    const hidden = await realApp.inject({ method: "GET", url: "/mock/creative_center/hashtag/list" });
    expect(hidden.statusCode).toBe(404);
    await realApp.close();
  });
});

describe("mock fixtures", () => {
  it("returns growing counts so the velocity engine sees real deltas", () => {
    const early = mockTikTokResponse(
      "/api/challenge/detail/",
      new URLSearchParams({ challengeName: "babynames" }),
      1_800_000_000,
    ) as { challengeInfo: { stats: { viewCount: number } } };
    const later = mockTikTokResponse(
      "/api/challenge/detail/",
      new URLSearchParams({ challengeName: "babynames" }),
      1_800_000_000 + 3600,
    ) as { challengeInfo: { stats: { viewCount: number } } };
    expect(later.challengeInfo.stats.viewCount).toBeGreaterThan(early.challengeInfo.stats.viewCount);
  });

  it("covers the endpoints the facade asks for", () => {
    const paths = [
      ["/api/search/item/full/", { keyword: "baby names" }],
      ["/api/user/detail/", { uniqueId: "nobodynamed" }],
      ["/api/post/item_list/", { secUid: "x" }],
      ["/api/item/detail/", { itemId: "7400000000000000000" }],
      ["/api/comment/list/", { aweme_id: "7400000000000000000" }],
      ["/api/challenge/detail/", { challengeName: "babynames" }],
      ["/api/music/detail/", { musicId: "7300000000000000001" }],
    ] as const;
    for (const [path, params] of paths) {
      const body = mockTikTokResponse(path, new URLSearchParams(params));
      expect(body, `${path} fixture missing`).not.toBeNull();
    }
    expect(mockCreativeCenterResponse("/hashtag/list", new URLSearchParams())).not.toBeNull();
    expect(mockCreativeCenterResponse("/sound/list", new URLSearchParams())).not.toBeNull();
  });
});
